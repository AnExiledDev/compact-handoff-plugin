"""Reproduce a cold fork on demand, and show the fix makes it warm.

    python3 bench/coldfork.py --unfixed    # expect a cold fork, refused as `mismatch`
    python3 bench/coldfork.py              # expect a warm fork, `replaced`

What it reproduces. The handoff is written by `$.model.fork`, and in engine
2.1.283 that fork runs the ordinary query loop (querySource `hook_prompt`) over
the main thread's last request plus the fork prompt. The query loop checks for
auto-compaction on every loop, the fork's included: `hook_prompt` is in none of
the sets the check excludes. So when the main thread crosses its threshold by
less than the size of the fork prompt, the fork's own transcript is over the
same threshold, and the engine dispatches a second `session.compact` for the
fork loop, carrying the fork loop's `agentId`. A plugin that passes that one
through as a subagent gets its fork answered over the engine's summary of the
conversation, not the conversation: a fork charged for a fraction of the
context, which `forkInputOf` flags as `matchesContext: false`.

How it gets there, cheaply. A proactive auto-compaction needs a window whose
source is not the engine's `auto` default, so the window comes from
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` at the engine's 100k floor. The session reads
generated files until it is just under the threshold, then crosses it with
small prompts, each far smaller than the fork prompt. The engine logs its
effective window at every check (`autocompact: ... effectiveWindow=W` in the
debug file; the token count on that line is redacted), and the threshold is
`W - 13000`. The context is `$.session.usage().context.tokens` after each turn,
read off the probe below, so the harness steers on the engine's numbers rather
than a guess.

Everything runs in a scratch directory outside any checkout: its own
`CLAUDE_CONFIG_DIR` (a copy of this box's token, deleted when the run ends),
`--setting-sources ""` so no settings file or hook of the box's loads, its own
data dir, and a cwd with nothing in it but generated filler. A second plugin,
written into the scratch dir, appends `$.session.usage()` on every main-thread
`turn.complete`, which is how the harness knows a turn ended and what the
session spent.

`--unfixed` runs the plugin as it was before the fix, exported with
`git archive` from the parent of the commit that introduced `isOwnForkLoop`
(or HEAD, while no commit has), unless `--ref` names another.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

import pexpect

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = "claude-haiku-4-5-20251001"
# The engine will not take a smaller window; below it the override is dropped.
WINDOW = 100_000
# `P7 = B4 - 13000` in 2.1.283: the proactive threshold sits this far under the
# effective window the debug line reports.
THRESHOLD_GAP = 13_000
# A `--plugin-dir` plugin is `<name>@inline`, and the engine also reads its
# options under the bare name.
LIVE_OPTION = {"pluginConfigs": {"compact-handoff": {"options": {"live": True}}}}
# The string that only exists in the plugin once the fix is in.
FIX_MARKER = "isOwnForkLoop"

ESCAPES = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b.")
EFFECTIVE_WINDOW = re.compile(r"autocompact: tokens=\S+ level=\w+ effectiveWindow=(\d+)")

PROBE_MODULE = """\
export const register = (on) => {
    on("turn.complete", async ($, e, next) => {
        const file = await $.env.get("COLDFORK_PROBE");

        if (file && (e.agentId === undefined || e.agentId === null)) {
            const usage = await $.session.usage();
            const line = JSON.stringify({ at: new Date().toISOString(), usage });

            await $.process.run(["sh", "-c", 'cat >> "$1"', "coldfork-probe", file], { stdin: `${line}\\n` });
        }

        return next(e);
    });
};
"""


# ------------------------------------------------------------------ #
# The scratch world one run lives in.
# ------------------------------------------------------------------ #


class Scratch:
    def __init__(self, root):
        self.root = root
        self.config = os.path.join(root, "config")
        self.data = os.path.join(root, "data")
        self.logs = os.path.join(root, "logs")
        self.work = os.path.join(root, "work")
        self.probe_dir = os.path.join(root, "probe-plugin")
        self.probe = os.path.join(root, "logs", "probe.jsonl")
        self.debug = os.path.join(root, "logs", "debug.log")
        self.screen_log = os.path.join(root, "logs", "session.log")

        for directory in (self.config, self.data, self.logs, self.work):
            os.makedirs(directory, exist_ok=True)


def lend_credentials(config):
    source = os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json")

    if not os.path.isfile(source):
        sys.exit(f"no credentials at {source}; an interactive session cannot log in without them")

    subprocess.run(["install", "-m", "600", source, os.path.join(config, ".credentials.json")], check=True)


def drop_credentials(config):
    path = os.path.join(config, ".credentials.json")

    if os.path.isfile(path):
        os.remove(path)


def seed_user_config(config, cwd):
    """Just enough `.claude.json` that the TUI opens on the prompt, not on onboarding or the trust dialog."""
    seeded = {
        "hasCompletedOnboarding": True,
        "bypassPermissionsModeAccepted": True,
        "mcpServers": {},
        "projects": {
            cwd: {
                "hasTrustDialogAccepted": True,
                "allowedTools": [],
                "mcpServers": {},
                "enabledMcpjsonServers": [],
                "disabledMcpjsonServers": [],
            }
        },
    }
    ambient = os.path.join(os.path.expanduser("~"), ".claude.json")

    if os.path.isfile(ambient):
        with open(ambient, encoding="utf-8") as handle:
            source = json.load(handle)

        for key in ("userID", "installMethod", "firstStartTime", "numStartups", "migrationVersion"):
            if key in source:
                seeded[key] = source[key]

    with open(os.path.join(config, ".claude.json"), "w", encoding="utf-8") as handle:
        json.dump(seeded, handle, indent=2)


def write_probe(directory):
    os.makedirs(os.path.join(directory, ".claude-plugin"), exist_ok=True)
    os.makedirs(os.path.join(directory, "hooks"), exist_ok=True)

    manifest = {"name": "coldfork-probe", "version": "0.0.0", "description": "Logs session usage per turn"}

    with open(os.path.join(directory, ".claude-plugin", "plugin.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    with open(os.path.join(directory, "hooks", "hooks.json"), "w", encoding="utf-8") as handle:
        json.dump({"description": "coldfork probe", "modules": ["module.js"]}, handle, indent=2)

    with open(os.path.join(directory, "hooks", "module.js"), "w", encoding="utf-8") as handle:
        handle.write(PROBE_MODULE)


def write_filler(directory, count, chars):
    """Files that say nothing, sized so one Read returns the whole file. No real content, ever."""
    paths = []

    for part in range(count):
        path = os.path.join(directory, f"filler-{part:02d}.txt")
        lines = []
        n = 0

        while sum(len(line) + 1 for line in lines) < chars:
            lines.append(f"{part:02d}.{n:05d} " + " ".join(f"filler{(n * 7 + w) % 997:03d}" for w in range(9)))
            n += 1

        with open(path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")

        paths.append(path)

    return paths


def padding(words):
    return " ".join(f"pad{(n * 13) % 991:03d}" for n in range(words))


def unfixed_ref():
    """The parent of the first commit carrying the fix, or HEAD while none does."""
    out = subprocess.run(
        ["git", "-C", PLUGIN, "log", "--reverse", "--format=%H", "-S", FIX_MARKER, "--", "hooks/module.js"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()

    return f"{out[0]}^" if out else "HEAD"


def export_plugin(ref, target):
    os.makedirs(target, exist_ok=True)

    archive = subprocess.run(["git", "-C", PLUGIN, "archive", ref], capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", target], input=archive, check=True)

    with open(os.path.join(target, "hooks", "module.js"), encoding="utf-8") as handle:
        if FIX_MARKER in handle.read():
            sys.exit(f"{ref} already carries {FIX_MARKER}; it is not the unfixed plugin")

    return target


def claude_version():
    try:
        out = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=30)

        return out.stdout.strip().split()[0]
    except Exception:
        return "unknown"


# ------------------------------------------------------------------ #
# Reading back what happened.
# ------------------------------------------------------------------ #


def read_jsonl(path):
    if not os.path.isfile(path):
        return []

    found = []

    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()

            if line:
                try:
                    found.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

    return found


def plugin_rows(scratch):
    return read_jsonl(os.path.join(scratch.data, "index.jsonl"))


def main_rows(scratch):
    return [row for row in plugin_rows(scratch) if not row.get("agentId") and row.get("trigger") != "precompute"]


def turns(scratch):
    return read_jsonl(scratch.probe)


def effective_window(scratch):
    """The last effective window the engine logged, or None before its first check."""
    if not os.path.isfile(scratch.debug):
        return None

    with open(scratch.debug, encoding="utf-8", errors="replace") as handle:
        found = EFFECTIVE_WINDOW.findall(handle.read())

    return int(found[-1]) if found else None


def context_tokens(scratch):
    """What the session held at the end of its last main-thread turn."""
    recorded = turns(scratch)

    if not recorded:
        return None

    return ((recorded[-1].get("usage") or {}).get("context") or {}).get("tokens")


def debug_count(scratch, phrase):
    if not os.path.isfile(scratch.debug):
        return 0

    with open(scratch.debug, encoding="utf-8", errors="replace") as handle:
        return handle.read().count(phrase)


# ------------------------------------------------------------------ #
# Driving the session.
# ------------------------------------------------------------------ #


def pump(child, seconds):
    end = time.time() + seconds

    while time.time() < end:
        try:
            child.expect([pexpect.TIMEOUT], timeout=1)
        except pexpect.EOF:
            return


def screen(child, tail=4000):
    child.logfile_read.flush()

    with open(child.logfile_read.name, encoding="utf-8", errors="replace") as handle:
        text = handle.read()[-tail:]

    return ESCAPES.sub("", text).replace(" ", "")


def accept_bypass(child):
    """The bypass-permissions warning needs its second option; the default one exits."""
    end = time.time() + 40

    while time.time() < end:
        if "Yes,Iaccept" in screen(child):
            break

        pump(child, 2)
    else:
        return False

    for _ in range(4):
        if "❯Yes,Iaccept" not in screen(child):
            child.send("\x1bOB")
            pump(child, 2)

        if "❯Yes,Iaccept" not in screen(child):
            continue

        child.send("\r")
        pump(child, 4)

        if "Yes,Iaccept" not in screen(child, tail=1500):
            return True

    raise RuntimeError("the bypass dialog would not clear; refusing to type into it")


def say(child, text):
    child.send("\x15")
    pump(child, 1)
    child.send(text)
    pump(child, 2)
    child.send("\r")


def ask(child, scratch, text, deadline):
    """One prompt, waited on until the probe records the turn's end."""
    before = len(turns(scratch))

    say(child, text)

    end = time.time() + deadline

    while time.time() < end:
        pump(child, 3)

        if len(turns(scratch)) > before:
            return True

    return False


def quit_session(child):
    try:
        child.send("\x1b")
        pump(child, 2)
        child.send("\x15")
        pump(child, 1)
        child.send("/quit\r")
        pump(child, 5)
    except Exception:
        pass

    child.close(force=True)


def spawn(scratch, plugin, model):
    env = dict(os.environ)
    env["CLAUDE_CONFIG_DIR"] = scratch.config
    env["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"] = "1"
    env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = str(WINDOW)
    env["COMPACT_HANDOFF_DATA_DIR"] = scratch.data
    env["COMPACT_HANDOFF_LIVE"] = "1"
    env["COLDFORK_PROBE"] = scratch.probe
    env["CLAUDE_CODE_VERSION"] = claude_version()
    env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"] = "1"

    for name in ("DISABLE_AUTO_COMPACT", "DISABLE_COMPACT", "CLAUDE_CODE_CHILD_SESSION"):
        env.pop(name, None)

    argv = [
        "--setting-sources", "",
        # Before 0.11.0 the manifest's `live` default of false reached the
        # module as a set value and outranked COMPACT_HANDOFF_LIVE, so an
        # --unfixed run needs live as the plugin option too. Flag settings
        # load even with no setting sources.
        "--settings", json.dumps(LIVE_OPTION),
        "--plugin-dir", plugin,
        "--plugin-dir", scratch.probe_dir,
        "--model", model,
        "--permission-mode", "bypassPermissions",
        # A delegated Read would put the tokens in a subagent's transcript, not
        # this one, and a real subagent compacting is a different event.
        "--disallowed-tools", "Task", "Agent",
        "--debug-file", scratch.debug,
    ]

    child = pexpect.spawn(
        "claude",
        argv,
        cwd=scratch.work,
        env=env,
        timeout=1800,
        dimensions=(50, 160),
        encoding="utf-8",
        codec_errors="replace",
    )
    child.logfile_read = open(scratch.screen_log, "w", buffering=1)

    pump(child, 10)
    accept_bypass(child)

    return child


# ------------------------------------------------------------------ #
# The run.
# ------------------------------------------------------------------ #


def drive(child, scratch, args):
    """Fill to just under the threshold with big reads, then cross it with small prompts."""
    fillers = write_filler(scratch.work, 30, args.filler_chars)

    if not ask(child, scratch, "Reply with only the word ready, and call no tools.", 120):
        return "the warm-up turn never completed"

    window = effective_window(scratch)
    reading = context_tokens(scratch)

    if window is None or reading is None:
        return f"no effective window ({window}) or context reading ({reading}) after the warm-up"

    threshold = window - THRESHOLD_GAP

    print(f"  effective window {window}, threshold {threshold}, context {reading} after the warm-up", flush=True)

    for path in fillers:
        name = os.path.basename(path)
        before = reading

        if not ask(child, scratch, f"Read {name} in full with the Read tool, then reply with only its first line.", 180):
            return f"the read of {name} never completed"

        reading = context_tokens(scratch)
        last_delta = reading - before
        print(f"  read {name}: context {reading} (+{last_delta})", flush=True)

        if main_rows(scratch):
            return "a read crossed the threshold on its own; lower --filler-chars or raise --approach"

        if reading + 1.3 * last_delta + args.approach >= threshold:
            break
    else:
        return "ran out of filler before reaching the threshold"

    step = f"Reply with only the word OK and call no tools. Ignore this padding: {padding(args.pad_words)}"

    for n in range(args.max_steps):
        rows_before = len(main_rows(scratch))

        # A turn that compacts waits on two model calls (the fork, and the
        # engine's own when the fork is refused) before it answers.
        ask(child, scratch, step, 600)
        reading = context_tokens(scratch)
        print(f"  step {n + 1}: context {reading}", flush=True)

        if len(main_rows(scratch)) > rows_before:
            return None

        if reading > threshold + 8_000:
            return f"context {reading} is well past the threshold {threshold} and nothing compacted"

    return f"{args.max_steps} small steps and no main-thread compaction"


def summarise(scratch, label, ref, failure):
    rows = plugin_rows(scratch)
    main = [row for row in rows if not row.get("agentId") and row.get("trigger") != "precompute"]
    partners = [row for row in rows if row.get("agentId")]
    spent = turns(scratch)
    cost = ((spent[-1].get("usage") or {}).get("cost") or {}).get("usd") if spent else None

    def main_view(row):
        return {
            "at": row.get("at"),
            "trigger": row.get("trigger"),
            "disposition": row.get("disposition"),
            "outcome": row.get("outcome"),
            "forkOutcome": row.get("forkOutcome"),
            "forkInput": row.get("forkInput"),
            "messagesIn": row.get("messagesIn"),
            "pinnable": row.get("pinnable"),
            "context": ((row.get("forkContext") or {}).get("context") or {}).get("tokens"),
            "usage": row.get("usage"),
        }

    def partner_view(row):
        return {
            "at": row.get("at"),
            "agentId": row.get("agentId"),
            "trigger": row.get("trigger"),
            "disposition": row.get("disposition"),
            "outcome": row.get("outcome"),
            "messagesIn": row.get("messagesIn"),
            "pinnable": row.get("pinnable"),
        }

    return {
        "label": label,
        "ref": ref,
        "scratch": scratch.root,
        "engine": claude_version(),
        "failure": failure,
        "main": [main_view(row) for row in main],
        "partners": [partner_view(row) for row in partners],
        "engineLog": {
            "routedReactive": debug_count(scratch, "autocompact: routing through reactive"),
            "reactiveSkipped": debug_count(scratch, "Reactive compact skipped"),
        },
        "sessionUsd": cost,
    }


def verdict(summary, unfixed):
    """Cold on the unfixed plugin, warm and replaced with the fix."""
    if summary["failure"] or not summary["main"]:
        return False, summary["failure"] or "no main-thread compaction row"

    row = summary["main"][0]
    matches = (row.get("forkInput") or {}).get("matchesContext")
    waved = [p for p in summary["partners"] if p.get("outcome") == "subagent"]

    if unfixed:
        cold = matches is False and row.get("forkOutcome") == "mismatch" and bool(summary["partners"])

        return cold, f"forkOutcome={row.get('forkOutcome')}, matchesContext={matches}, partners={len(summary['partners'])}"

    # Warm alone proves nothing unless the fork loop really crossed the
    # threshold and was declined; a run that never got there is no evidence.
    declined = any(p.get("outcome") == "ownFork" for p in summary["partners"])
    warm = matches is True and row.get("disposition") == "replaced" and not waved and declined

    return warm, (
        f"disposition={row.get('disposition')}, matchesContext={matches}, "
        f"fork loop passed through to the engine: {len(waved)}, declined: {declined}"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--unfixed", action="store_true", help="run the plugin as it was before the fix")
    parser.add_argument("--ref", help="with --unfixed, the git ref to export instead of the pre-fix parent")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--scratch", default=os.environ.get("COLDFORK_DIR", "/tmp/compact-handoff-coldfork"))
    parser.add_argument("--filler-chars", type=int, default=12_000, help="size of each file read on the way up")
    parser.add_argument("--approach", type=int, default=1_200, help="stop reading this far under the threshold")
    parser.add_argument("--pad-words", type=int, default=150, help="padding in each small step; the step must stay well under the fork prompt (2.8k chars)")
    parser.add_argument("--max-steps", type=int, default=40)
    args = parser.parse_args()

    label = "unfixed" if args.unfixed else "fixed"
    scratch = Scratch(os.path.join(args.scratch, f"{label}-{time.strftime('%Y%m%dT%H%M%S')}"))
    ref = None
    plugin = PLUGIN

    if args.unfixed:
        ref = args.ref or unfixed_ref()
        plugin = export_plugin(ref, os.path.join(scratch.root, "plugin"))

    write_probe(scratch.probe_dir)
    seed_user_config(scratch.config, scratch.work)
    lend_credentials(scratch.config)

    print(f"{label} run in {scratch.root} (plugin {plugin}{f', ref {ref}' if ref else ''})", flush=True)

    child = None
    failure = None

    try:
        child = spawn(scratch, plugin, args.model)
        failure = drive(child, scratch, args)

        # The row is written before the turn answers; let the artifacts land.
        pump(child, 10)
    except Exception as error:
        failure = f"{type(error).__name__}: {error}"
    finally:
        if child is not None:
            quit_session(child)

        drop_credentials(scratch.config)

    summary = summarise(scratch, label, ref, failure)
    ok, detail = verdict(summary, args.unfixed)
    summary["ok"] = ok
    summary["detail"] = detail

    with open(os.path.join(scratch.root, "result.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print(json.dumps(summary, indent=2))
    print(f"{'PASS' if ok else 'FAIL'} {label}: {detail}", flush=True)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
