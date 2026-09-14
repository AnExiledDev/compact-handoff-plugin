"""Drive real Claude Code sessions through the compactions the plugin claims to answer.

Every check here runs a throwaway pty session against an isolated
`CLAUDE_CONFIG_DIR` and an isolated `COMPACT_HANDOFF_DATA_DIR`, so nothing it
does touches the operator's config, this box's hooks, or the handoffs of any
session a person is actually using. What it asserts is read back out of the rows
the plugin wrote, never out of what the terminal printed: a toast on screen is
not evidence that anything was stored.

    python3 bench/verify.py setup
    python3 bench/verify.py run manual auto
    python3 bench/verify.py table

`setup` copies a large transcript in as a fresh session (see fixture.py) and
writes the isolated config. `run` takes check names, or `all`. Each check
appends its own verdict to `verify.jsonl` in the scratch dir, so a check that
fails can be re-run on its own without paying for the ones that passed.

The session model is deliberately settable: these checks verify the *mechanism*,
and the mechanism does not care which model wrote the summary. Handoff quality
was measured separately, on Sonnet 5, in RESULTS.md.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import uuid

import pexpect

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKTREE = os.path.dirname(os.path.dirname(PLUGIN))
# A session's transcript lives under its own config dir, so an isolated
# CLAUDE_CONFIG_DIR cannot resume a fixture written into the ambient one.
PROJECT_NAME = "-home-deploy-workspace-claude-investigations--claude-worktrees-compact-handoff-plugin"

SCRATCH = os.environ.get("COMPACT_HANDOFF_VERIFY_DIR") or os.path.join(
    os.environ.get("CLAUDE_JOB_DIR", "/tmp"), "tmp", "verify"
)
CONFIG = os.path.join(SCRATCH, "config")
CONFIG_AUTO = os.path.join(SCRATCH, "config-auto")
DATA = os.path.join(SCRATCH, "data")
LOGS = os.path.join(SCRATCH, "logs")
STATE = os.path.join(SCRATCH, "state.json")
VERDICTS = os.path.join(SCRATCH, "verify.jsonl")

# Auto-compaction fires at a percentage of this, so a small window is what makes
# check `auto` affordable: the alternative is paying for a 180k-token session.
# The engine will not take a window below this. `autoCompactWindow` is validated
# against 100k-1M (`_Me`/`$Ke` in the 2.1.270 binary, and the `/autocompact`
# help says the same), and a value outside that range is dropped in silence
# rather than rejected: `config/settings.json` kept its 200000 while
# `config-auto/settings.json` came back with no window key at all. That is why
# the `auto` check spent twelve turns on a 146k-token fixture and never
# compacted - it was running on the 1M default the whole time.
MIN_WINDOW = 100_000

SMALL_WINDOW = MIN_WINDOW

# The two checks that need the engine to compact on its own rather than being
# asked to. Both run in the small-window config; everything else has
# auto-compaction off so a large fixture cannot compact itself out from under
# the thing being measured.
AUTO_CHECKS = ("auto", "subagent")


# ------------------------------------------------------------------ #
# The scratch environment.
# ------------------------------------------------------------------ #


def state():
    if not os.path.isfile(STATE):
        return {}

    with open(STATE, encoding="utf-8") as handle:
        return json.load(handle)


def save_state(update):
    current = state()
    current.update(update)

    os.makedirs(SCRATCH, exist_ok=True)

    with open(STATE, "w", encoding="utf-8") as handle:
        json.dump(current, handle, indent=2)


def write_config(directory, window):
    """A config dir with this box's credentials and none of its behaviour.

    Credentials live inside the config dir, so an empty one cannot log in, and
    a check that cannot log in measures nothing. It is a copy rather than a
    symlink so a session here cannot rewrite the operator's token. `do_run`
    lends it again on every run and deletes it when the run is over, so a
    cleanup between runs is not a trap.

    The plugin itself no longer does this. Its commitments pass takes the
    ambient config dir and `--setting-sources ""` instead, which needs no copy;
    see the A4 comment in `hooks/module.js`. A bench is a different case: these
    sessions are the thing under test and have to carry real settings.
    """
    os.makedirs(directory, exist_ok=True)

    if window < MIN_WINDOW:
        raise ValueError(f"autoCompactWindow {window} is below the engine's {MIN_WINDOW} floor and would be dropped")

    settings = {
        "autoCompactWindow": window,
        "autoCompactEnabled": True,
        "includeCoAuthoredBy": False,
        # Without this the TUI stops on the bypass-permissions warning and
        # never reads a keystroke meant for the prompt.
        "bypassPermissionsModeAccepted": True,
        "permissions": {"defaultMode": "bypassPermissions"},
    }

    with open(os.path.join(directory, "settings.json"), "w", encoding="utf-8") as handle:
        json.dump(settings, handle, indent=2)

    seed_onboarding(directory)

    return copy_credentials(directory)


def copy_credentials(directory):
    """Lend one config dir this box's token, as a copy at mode 600.

    A copy rather than a symlink so a bench session cannot rewrite the
    operator's real token, and short-lived: `do_run` drops it again in a
    `finally`, so it never outlives the run that needed it.
    """
    source = os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json")

    if not os.path.isfile(source):
        return False

    subprocess.run(["install", "-m", "600", source, os.path.join(directory, ".credentials.json")], check=True)

    return True


def lend_credentials():
    """Both bench config dirs get the token for the length of one run.

    This is here because leaving it to `setup` was a trap. Credentials live
    inside the config dir, a check is a real interactive session and cannot log
    in without one, and a run that cannot log in does not fail loudly: check 1
    comes back `fellBack` at around a hundred milliseconds, which reads exactly
    like a regression in the plugin and is not one. Copying is idempotent, so
    doing it on every run costs nothing and removes the incantation.
    """
    return all([copy_credentials(CONFIG), copy_credentials(CONFIG_AUTO)])


def drop_credentials():
    """Take the token back out of both config dirs."""
    for directory in (CONFIG, CONFIG_AUTO):
        path = os.path.join(directory, ".credentials.json")

        if os.path.isfile(path):
            os.remove(path)


def seed_onboarding(directory):
    """Enough of the user config that the TUI does not open the login chooser.

    Credentials alone are enough for a headless `claude -p` (which is what the
    plugin's own isolated config does), but an interactive session with no
    `hasCompletedOnboarding` walks into the auth-method picker and sits there
    until the deadline expires. Measured: the first run of this file did exactly
    that for 420 s. Only the onboarding flags are copied, never the 41 projects
    and never an MCP server.
    """
    source = os.path.join(os.path.expanduser("~"), ".claude.json")
    seeded = {
        "hasCompletedOnboarding": True,
        "bypassPermissionsModeAccepted": True,
        "mcpServers": {},
        # Without this the TUI opens the trust dialog on the worktree and waits
        # there forever; the second failed run of this file was exactly that.
        "projects": {
            WORKTREE: {
                "hasTrustDialogAccepted": True,
                "hasClaudeMdExternalIncludesApproved": True,
                "hasClaudeMdExternalIncludesWarningShown": True,
                "allowedTools": [],
                "mcpServers": {},
                "enabledMcpjsonServers": [],
                "disabledMcpjsonServers": [],
            }
        },
    }

    if os.path.isfile(source):
        with open(source, encoding="utf-8") as handle:
            ambient = json.load(handle)

        for key in ("userID", "installMethod", "firstStartTime", "numStartups", "migrationVersion"):
            if key in ambient:
                seeded[key] = ambient[key]

    with open(os.path.join(directory, ".claude.json"), "w", encoding="utf-8") as handle:
        json.dump(seeded, handle, indent=2)


def env_for(check, extra=None):
    """The environment one check runs in.

    Auto-compaction is off for every check but `auto`, and `auto` gets its own
    config dir with a small `autoCompactWindow`. Otherwise a fixture sized to be
    worth compacting would compact itself out from under whatever the check was
    actually measuring, and every row would read as an auto compaction.
    """
    env = dict(os.environ)
    env["CLAUDE_CONFIG_DIR"] = config_for(check)
    env["COMPACT_HANDOFF_DATA_DIR"] = DATA
    env["COMPACT_HANDOFF_LIVE"] = "1"
    env["CLAUDE_CODE_VERSION"] = claude_version()
    # A session spawned from inside another one inherits CLAUDE_CODE_CHILD_SESSION
    # and writes no transcript at all, so nothing could be resumed and the plugin
    # would have no conversation to read.
    env.pop("CLAUDE_CODE_CHILD_SESSION", None)
    env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"] = "1"

    if check in AUTO_CHECKS:
        env.pop("DISABLE_AUTO_COMPACT", None)
    else:
        env["DISABLE_AUTO_COMPACT"] = "1"

    env.update(extra or {})

    return env


def claude_version():
    try:
        out = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=30)

        return out.stdout.strip().split()[0]
    except Exception:
        return "unknown"


# ------------------------------------------------------------------ #
# Reading back what the plugin stored.
# ------------------------------------------------------------------ #


def rows():
    """Every compaction row this scratch data dir holds, oldest first."""
    path = os.path.join(DATA, "index.jsonl")

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

    found.sort(key=lambda row: row.get("at") or "")

    return found


def row_count():
    return len(rows())


def new_rows(before):
    return rows()[before:]


# ------------------------------------------------------------------ #
# Driving a session.
# ------------------------------------------------------------------ #


def spawn(session, log, env, model=None, fresh=False, ban=()):
    argv = ["--plugin-dir", PLUGIN, "--permission-mode", "bypassPermissions"]

    if ban:
        argv += ["--disallowed-tools", *ban]

    if model:
        argv += ["--model", model]

    if session and not fresh:
        argv += ["--resume", session]

    os.makedirs(LOGS, exist_ok=True)

    child = pexpect.spawn(
        "claude",
        argv,
        cwd=WORKTREE,
        env=env,
        timeout=1800,
        dimensions=(50, 160),
        encoding="utf-8",
        codec_errors="replace",
    )
    child.logfile_read = open(os.path.join(LOGS, log), "w", buffering=1)
    accept_bypass(child)

    return child


ESCAPES = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b.")


def screen(child, tail=4000):
    """What the TUI has drawn lately, with the escape codes taken out.

    `expect` matches the raw stream, where the TUI can put a colour code in the
    middle of a word, so anything that has to read the screen reads it here.
    Spaces go too: the dialog draws its options padded and the padding varies.
    """
    child.logfile_read.flush()

    with open(child.logfile_read.name, encoding="utf-8", errors="replace") as handle:
        text = handle.read()[-tail:]

    return ESCAPES.sub("", text).replace(" ", "")


def accept_bypass(child, attempts=4):
    """Clear the bypass-permissions warning, which no settings key suppresses.

    `bypassPermissionsModeAccepted` in the isolated settings.json and in its
    .claude.json both leave the dialog up, and while it is up the TUI eats every
    keystroke meant for the prompt. So answer it: the second choice is
    "Yes, I accept". A session that never shows it just times out here.

    **Confirm the cursor moved before pressing Enter.** Sending the down-arrow
    and Enter blind loses the session outright when the arrow does not land: the
    default choice is "No, exit", so the Enter meant to accept quits instead.
    That is what happened to check `auto` on 2026-09-14 - the whole session was
    963 characters of dialog and twelve prompts typed into a TUI that was gone.
    """
    # Not `expect`: that matches the raw stream, and the TUI draws a colour code
    # in the middle of the phrase, so "I accept" is never literally there. Probed
    # on 2026-09-14 - 1208 bytes of dialog, `"I accept" in raw` False and
    # `"Yes,Iaccept" in screen()` True - which is why the two auto checks typed
    # twelve prompts into a session that had never started.
    end = time.time() + 25

    while time.time() < end:
        if "Yes,Iaccept" in screen(child):
            break

        pump(child, 2)
    else:
        return False

    for _ in range(attempts):
        # Only nudge when the cursor is not already there. Two options wrap, so
        # a blind second press can walk it straight back onto "No, exit".
        if "\u276fYes,Iaccept" not in screen(child):
            child.send("\x1bOB")
            pump(child, 2)

        if "\u276fYes,Iaccept" not in screen(child):
            continue

        child.send("\r")
        pump(child, 4)

        if "Yes,Iaccept" not in screen(child, tail=1500):
            return True

    raise RuntimeError("the bypass dialog would not clear; refusing to type into it")


def pump(child, seconds):
    end = time.time() + seconds

    while time.time() < end:
        try:
            child.expect([pexpect.TIMEOUT], timeout=2)
        except pexpect.EOF:
            return


def say(child, text, settle=2):
    """Type one prompt and submit it, starting from an input box known to be empty.

    The kill-line matters: a `/compact` leaves its own text in the box, so the
    next thing typed becomes `/compact <that text>` and compacts a second time
    with instructions. That is exactly how the first run of `manual` produced
    two rows, the second one dispositioned `instructed` on the word `/quit`.
    """
    child.send("\x15")
    pump(child, 1)
    child.send(text)
    pump(child, settle)
    child.send("\r")


def warm(child, settle=45):
    """Complete one real turn, because a fork with no warm transcript is null.

    `$.model.fork` reads the main thread's cache-safe snapshot, and a session
    that was resumed and never answered anything in this process has none: the
    first `manual` run compacted immediately after `--resume` and every row came
    back `forkOutcome: cold`.
    """
    say(child, "Reply with only the word ready, and call no tools.")
    pump(child, settle)


def wait_for_rows(child, before, wanted, deadline):
    """Wait on the plugin's own rows, not on a guess at how long a fork takes."""
    end = time.time() + deadline

    while time.time() < end:
        pump(child, 5)

        if row_count() - before >= wanted:
            return True

    return False


def wait_for_main_rows(child, before, wanted, deadline):
    """As above, but blind to subagent rows.

    Counting every row raced the thing under test: a subagent's own compaction
    lands in milliseconds, the main thread's takes sixteen seconds, and a check
    that stopped at the first row killed the session in between. The row was
    printed to the TUI and never reached `index.jsonl`.
    """
    end = time.time() + deadline

    while time.time() < end:
        pump(child, 5)

        if len([r for r in new_rows(before) if not r.get("agentId")]) >= wanted:
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


def record(name, ok, detail, evidence=None):
    os.makedirs(SCRATCH, exist_ok=True)

    verdict = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "check": name,
        "ok": ok,
        "detail": detail,
        "evidence": evidence or {},
    }

    with open(VERDICTS, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(verdict) + "\n")

    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)

    return verdict


def config_for(check):
    return CONFIG_AUTO if check in AUTO_CHECKS else CONFIG


def project_dir(check):
    return os.path.join(config_for(check), "projects", PROJECT_NAME)


def transcript_of(check, session):
    return os.path.join(project_dir(check), f"{session}.jsonl")


def fixture_copy(check):
    """A fresh session id over the same transcript, so checks cannot collide.

    The copy lands in the projects directory of the config dir this check runs
    under, because that is where `--resume` looks.
    """
    source = state().get("fixtureFile")

    if not source or not os.path.isfile(source):
        sys.exit("no fixture; run `verify.py setup` first")

    session = str(uuid.uuid4())

    os.makedirs(project_dir(check), exist_ok=True)

    target = transcript_of(check, session)

    with open(source, encoding="utf-8") as src, open(target, "w", encoding="utf-8") as dst:
        for line in src:
            dst.write(line.replace(state()["fixture"], session))

    return session


# ------------------------------------------------------------------ #
# The checks. Each returns a verdict and pays for exactly one session.
# ------------------------------------------------------------------ #


def check_manual(args):
    """A person types /compact and the plugin answers it."""
    session = fixture_copy("manual")
    before = row_count()

    child = spawn(session, "manual.log", env_for("manual"), model=args.model)
    pump(child, 45)
    warm(child)
    say(child, "/compact")

    got = wait_for_rows(child, before, 1, args.deadline)
    quit_session(child)

    fresh = new_rows(before)

    if not got or not fresh:
        return record("manual", False, f"no row appeared within {args.deadline}s", {"session": session})

    row = fresh[0]
    stored = (row.get("files") or {}).get(".md")
    on_disk = bool(stored and os.path.isfile(stored))

    ok = row.get("disposition") == "replaced" and on_disk

    return record(
        "manual",
        ok,
        f"{row.get('disposition')}, {row.get('handoffChars')} chars, "
        f"${(row.get('cost') or {}).get('totalUsd')}, {row.get('elapsedMs')}ms",
        {"session": session, "row": row.get("at"), "file": stored, "trigger": row.get("trigger")},
    )


def check_auto(args):
    """An auto compaction dispatches a real event, not just a precompute.

    A fresh session that grows into the window, not the fixture resumed into it.
    The fixture is 146k tokens against a 100k window, so `--resume` puts the
    session over the line before it has answered anything in this process, the
    fork is cold, and the row comes back `fellBack` / `noHandoff` however well
    the dispatch worked. That is a real limit and it has its own line in the
    README; it is not what this check is for. So: warm the fork on a turn of its
    own, then read a generated corpus a file at a time until the window goes.
    """
    before = row_count()

    # Many small files rather than a few large ones, because what this check
    # needs is turns, not tokens. This repo's `CLAUDE.md` pulls in a very large
    # `AGENTS.md`, so a session here starts around 80k tokens against the 100k
    # floor and two 10k-token reads were enough to cross it at ten messages -
    # before the disk handoff below is ever written, since that needs twenty.
    # A thousand tokens a file spends the same headroom over twenty-odd turns.
    corpus = write_corpus(parts=30, chars=4_000)

    # No Task tool. Handed the reads as a prompt, the model delegated them, the
    # main thread crossed the window while that Task was still in flight, and the
    # fork came back cold because the turn it would snapshot had not finished.
    #
    # Nothing else is turned on here. Four earlier attempts came back
    # `fellBack` / `noHandoff` / `forkOutcome: cold` and read as "an auto
    # compaction can never fork warm"; they were all sessions that crossed the
    # window ten to fifteen messages in, on the turn that crossed it. Given
    # turns that finish before the line, the fork is warm on an auto compaction
    # exactly as it is on a manual one, which is what this check now shows.
    child = spawn(None, "auto.log", env_for("auto"), model=args.model, fresh=True, ban=("Task",))
    pump(child, 45)
    warm(child)

    for path in corpus:
        say(child, f"Read {path} in full yourself with the Read tool and reply with only its first line.")

        if wait_for_main_rows(child, before, 1, 20):
            break

    got = wait_for_main_rows(child, before, 1, 120)

    # The row is on disk by now; the artifacts beside it may not be.
    pump(child, 10)
    quit_session(child)

    fresh = new_rows(before)
    main = [r for r in fresh if not r.get("agentId")]

    if not got or not main:
        return record("auto", False, f"no main-thread auto compaction within {len(corpus)} corpus file(s)")

    row = main[0]
    triggers = [r.get("trigger") for r in fresh]
    precompute = [t for t in triggers if t == "precompute"]

    ok = row.get("disposition") == "replaced" and row.get("trigger") == "auto" and not precompute

    return record(
        "auto",
        ok,
        f"trigger={row.get('trigger')}, disposition={row.get('disposition')}, {len(fresh)} row(s), "
        f"no precompute row: {not precompute}, fork {row.get('forkOutcome')}, source {row.get('outcome')}",
        {"triggers": triggers, "cost": (row.get("cost") or {}).get("totalUsd")},
    )


def check_depth(args):
    """A second compaction reads the first one's ledger rather than its prose."""
    session = fixture_copy("depth")
    before = row_count()

    child = spawn(session, "depth.log", env_for("depth"), model=args.model)
    pump(child, 45)
    warm(child)

    say(child, "/compact")
    wait_for_rows(child, before, 1, args.deadline)

    say(child, "Run `git log --oneline -1` and say nothing else.")
    pump(child, 25)

    say(child, "/compact")
    got = wait_for_rows(child, before, 2, args.deadline)
    quit_session(child)

    fresh = new_rows(before)

    if not got or len(fresh) < 2:
        return record("depth", False, f"only {len(fresh)} compaction(s) recorded", {"session": session})

    second = fresh[1]
    stored = json.load(open((second.get("files") or {}).get(".json"), encoding="utf-8"))
    earlier = stored.get("earlier") or []

    ok = second.get("depth") == 2 and second.get("prev") == 1 and len(earlier) > 0

    return record(
        "depth",
        ok,
        f"depth={second.get('depth')}, prev={second.get('prev')}, {len(earlier)} earlier ledger row(s) merged",
        {"session": session, "depths": [r.get("depth") for r in fresh]},
    )


def check_instructions(args):
    """/compact with instructions still produces a full handoff."""
    session = fixture_copy("instructions")
    before = row_count()

    child = spawn(session, "instructions.log", env_for("instructions"), model=args.model)
    pump(child, 45)
    warm(child)
    say(child, "/compact Focus on the commands that were run and their outcomes.")

    got = wait_for_rows(child, before, 1, args.deadline)
    quit_session(child)

    fresh = new_rows(before)

    if not got or not fresh:
        return record("instructions", False, "no row appeared", {"session": session})

    row = fresh[0]
    parts = row.get("parts") or {}
    ok = row.get("disposition") == "replaced" and isinstance(parts.get("ledger"), int)

    return record(
        "instructions",
        ok,
        f"{row.get('disposition')}, summary {row.get('summaryChars')} chars, ledger {parts.get('ledger')} chars",
        {"session": session, "parts": parts},
    )


def check_blob(args):
    """A pasted blob is trimmed to a pointer and the summary is never touched."""
    session = fixture_copy("blob")
    before = row_count()

    blob = "PASTE-" + ("x" * 29_990)
    env = env_for("blob", {"COMPACT_HANDOFF_MAX_CHARS": str(args.max_chars)})

    child = spawn(session, "blob.log", env, model=args.model)
    pump(child, 45)

    say(child, f"Here is a log I pasted. Reply with one word. {blob}", settle=6)
    pump(child, 25)

    say(child, "/compact")
    got = wait_for_rows(child, before, 1, args.deadline)
    quit_session(child)

    fresh = new_rows(before)

    if not got or not fresh:
        return record("blob", False, "no row appeared", {"session": session})

    row = fresh[0]
    after = row.get("handoffCharsAfter")
    trimmed = row.get("trimmedTurns") or 0
    summary = row.get("summaryChars") or 0

    handoff = (row.get("files") or {}).get(".md")
    summary_intact = False

    if handoff and os.path.isfile(handoff):
        text = open(handoff, encoding="utf-8").read()
        summary_intact = len(text) >= summary

    # The guard may not cut into the handoff itself, so a ceiling below it is
    # unreachable by design and the row says `overCeiling` rather than lying.
    # Passing that off as a failure is what the first run of this check did.
    floor = row.get("handoffChars") or 0
    fits = after <= args.max_chars or (row.get("overCeiling") and floor > args.max_chars)
    ok = trimmed >= 1 and fits and summary_intact

    return record(
        "blob",
        ok,
        f"{row.get('handoffCharsBefore')} -> {after} chars, {trimmed} turn(s) trimmed, "
        f"ceiling {args.max_chars}, untrimmable handoff {floor}, summary intact: {summary_intact}",
        {"session": session, "overCeiling": row.get("overCeiling")},
    )


def check_concurrent(args):
    """Two sessions compacting at once lose no rows, because nothing rewrites a file."""
    first = fixture_copy("concurrent")
    second = fixture_copy("concurrent")
    before = row_count()

    a = spawn(first, "concurrent-a.log", env_for("concurrent"), model=args.model)
    b = spawn(second, "concurrent-b.log", env_for("concurrent"), model=args.model)

    pump(a, 30)
    pump(b, 30)
    warm(a)
    warm(b)

    say(a, "/compact")
    say(b, "/compact")

    end = time.time() + args.deadline

    while time.time() < end and row_count() - before < 2:
        pump(a, 3)
        pump(b, 3)

    quit_session(a)
    quit_session(b)

    fresh = new_rows(before)
    sessions = {r.get("sessionId") for r in fresh}
    minutes = {(r.get("at") or "")[:16] for r in fresh}

    ok = len(fresh) == 2 and len(sessions) == 2

    return record(
        "concurrent",
        ok,
        f"{len(fresh)} row(s) from {len(sessions)} session(s) in {len(minutes)} minute(s)",
        {"sessions": sorted(sessions), "minutes": sorted(minutes)},
    )


def check_tools(args):
    """The session after a compaction can look the handoff back up."""
    session = fixture_copy("tools")
    before = row_count()

    child = spawn(session, "tools.log", env_for("tools"), model=args.model)
    pump(child, 45)
    warm(child)

    say(child, "/compact")
    wait_for_rows(child, before, 1, args.deadline)

    say(
        child,
        "Use the handoff_lookup tool with section=ledger. Then use handoff_search with pattern=git. "
        "Report what each returned in one line.",
    )
    pump(child, 90)

    quit_session(child)

    log = open(os.path.join(LOGS, "tools.log"), encoding="utf-8", errors="replace").read()
    fresh = new_rows(before)

    called = [name for name in ("handoff_lookup", "handoff_search") if name in log]
    post = None

    if fresh:
        json_path = (fresh[0].get("files") or {}).get(".json")

        if json_path:
            post_path = json_path[: -len(".json")] + ".post.json"

            if os.path.isfile(post_path):
                post = json.load(open(post_path, encoding="utf-8"))

    ok = len(called) == 2 and bool(fresh)

    return record(
        "tools",
        ok,
        f"{', '.join(called) or 'neither tool seen'}; monitor recorded {(post or {}).get('handoffToolsCalled')}",
        {"session": session, "post": post},
    )


def check_resume(args):
    """A resumed session still holds the handoff, because it replaced the messages."""
    session = fixture_copy("resume")
    before = row_count()

    child = spawn(session, "resume-a.log", env_for("resume"), model=args.model)
    pump(child, 45)
    warm(child)
    say(child, "/compact")

    got = wait_for_rows(child, before, 1, args.deadline)
    quit_session(child)

    if not got:
        return record("resume", False, "nothing to resume; no compaction recorded", {"session": session})

    child = spawn(session, "resume-b.log", env_for("resume"), model=args.model)
    pump(child, 45)
    say(child, "Without using any tool, quote the first line of the handoff you were given.")
    pump(child, 60)
    quit_session(child)

    transcript = transcript_of("resume", session)
    marker = "compact-handoff: session="
    in_transcript = marker in open(transcript, encoding="utf-8", errors="replace").read()

    log = open(os.path.join(LOGS, "resume-b.log"), encoding="utf-8", errors="replace").read()
    echoed = "compact-handoff" in log

    return record(
        "resume",
        in_transcript,
        f"lineage marker in the resumed transcript: {in_transcript}; session echoed it: {echoed}",
        {"session": session, "transcript": transcript},
    )


def write_corpus(parts=6, chars=80_000):
    """Enough plain text, in enough files, to push one conversation over the window.

    The two hook files are about 29k tokens together and the floor is 100k, so
    re-reading them cannot get a subagent there; nothing in this repo can without
    being read a dozen times. These are deterministic, about a thousand lines
    each so a single Read returns the whole file, and they say nothing, which is
    the point - the check is about the size of a conversation, not its content.
    """
    directory = os.path.join(SCRATCH, "corpus")

    os.makedirs(directory, exist_ok=True)

    paths = []

    for part in range(parts):
        path = os.path.join(directory, f"part-{part}.txt")
        lines = []
        n = 0

        while sum(len(line) + 1 for line in lines) < chars:
            lines.append(f"{part:02d}.{n:05d} " + " ".join(f"filler{(n + w) % 997:03d}" for w in range(9)))
            n += 1

        with open(path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")

        paths.append(path)

    return paths


def check_subagent(args):
    """A subagent's compaction is passed through, with a row saying so.

    A fresh parent, not the fixture: the subagent has to be the one that crosses
    the window, and a 146k-token parent on a 100k window compacts before the Task
    tool is ever called. So the parent stays small and the subagent is handed a
    generated corpus to read, which is what puts *its* conversation over.
    """
    before = row_count()
    corpus = write_corpus()

    child = spawn(None, "subagent.log", env_for("subagent"), model=args.model, fresh=True)
    pump(child, 45)

    listing = "\n".join(corpus)

    say(
        child,
        "Use the Task tool with subagent_type=general-purpose. Its prompt must tell it to read every one of "
        f"these files in full, in order, one Read call each, and then reply with the first line of each:\n{listing}\n"
        "Do nothing else yourself and call no other tools.",
    )

    got = wait_for_rows(child, before, 1, args.deadline)
    quit_session(child)

    fresh = new_rows(before)
    subagent = [r for r in fresh if r.get("agentId")]

    if not subagent:
        return record(
            "subagent",
            False,
            f"no subagent compaction occurred ({len(fresh)} row(s) total, got={got})",
            {"triggers": [r.get("trigger") for r in fresh]},
        )

    row = subagent[0]
    ok = row.get("disposition") == "passedThrough" and row.get("fallbackReason", "").startswith("subagent")

    return record(
        "subagent",
        ok,
        f"agentId={row.get('agentId')}, disposition={row.get('disposition')}, "
        f"reason={row.get('fallbackReason')}",
        {"cost": (row.get("cost") or {}).get("totalUsd")},
    )


CHECKS = {
    "manual": check_manual,
    "auto": check_auto,
    "depth": check_depth,
    "instructions": check_instructions,
    "blob": check_blob,
    "concurrent": check_concurrent,
    "tools": check_tools,
    "resume": check_resume,
    "subagent": check_subagent,
}


# ------------------------------------------------------------------ #
# Entry points.
# ------------------------------------------------------------------ #


def do_setup(args):
    os.makedirs(SCRATCH, exist_ok=True)
    os.makedirs(DATA, exist_ok=True)

    credentials = write_config(CONFIG, args.big_window)
    write_config(CONFIG_AUTO, args.window)

    out = subprocess.run(
        [sys.executable, os.path.join(PLUGIN, "bench", "fixture.py"), args.source, "--target", str(args.target)],
        capture_output=True,
        text=True,
        check=True,
    )

    print(out.stdout)

    session = None
    path = None

    for line in out.stdout.splitlines():
        if line.startswith("session"):
            session = line.split()[1]
        if line.startswith("file"):
            path = line.split()[1]

    save_state({"fixture": session, "fixtureFile": path, "window": args.window, "credentials": credentials})

    print(f"config      {CONFIG} (credentials copied: {credentials})")
    print(f"config-auto {CONFIG_AUTO}")
    print(f"data        {DATA}")
    print(f"window      {args.window}")


def do_run(args):
    names = list(CHECKS) if args.checks == ["all"] else args.checks

    for name in names:
        if name not in CHECKS:
            sys.exit(f"no check named {name}; have {', '.join(CHECKS)}")

    print(f"running {len(names)} check(s) against {DATA}", flush=True)

    if not lend_credentials():
        sys.exit("no ~/.claude/.credentials.json to lend; these checks are real sessions and cannot log in without one")

    try:
        for name in names:
            print(f"-- {name}", flush=True)

            try:
                CHECKS[name](args)
            except Exception as error:
                record(name, False, f"threw: {error}")
    finally:
        drop_credentials()


def do_table(args):
    if not os.path.isfile(VERDICTS):
        print("no verdicts recorded yet")
        return

    latest = {}

    for line in open(VERDICTS, encoding="utf-8"):
        line = line.strip()

        if line:
            verdict = json.loads(line)
            latest[verdict["check"]] = verdict

    print("| # | check | verdict | what was measured |")
    print("|---|-------|---------|-------------------|")

    for n, name in enumerate(CHECKS, start=1):
        verdict = latest.get(name)

        if not verdict:
            print(f"| {n} | {name} | not run | - |")
            continue

        print(f"| {n} | {name} | {'pass' if verdict['ok'] else 'FAIL'} | {verdict['detail']} |")

    spend = sum((row.get("cost") or {}).get("totalUsd") or 0 for row in rows())

    print(f"\n{row_count()} compaction row(s); the plugin's own priced spend was ${spend:.4f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)

    setup = sub.add_parser("setup")
    setup.add_argument("source", help="A transcript jsonl to re-home as the fixture.")
    setup.add_argument("--target", type=int, default=20_000)
    setup.add_argument("--window", type=int, default=SMALL_WINDOW, help="autoCompactWindow for the `auto` check.")
    setup.add_argument("--big-window", type=int, default=200_000, help="autoCompactWindow for every other check.")
    setup.set_defaults(func=do_setup)

    run = sub.add_parser("run")
    run.add_argument("checks", nargs="+", help="Check names, or `all`.")
    run.add_argument("--model", default="claude-haiku-4-5-20251001")
    run.add_argument("--deadline", type=int, default=400)
    run.add_argument("--turns", type=int, default=12)
    # Above the assembled handoff (a ~13k summary plus four appendices) and
    # below handoff-plus-blob, so the guard has a ceiling it can actually reach.
    run.add_argument("--max-chars", type=int, default=30_000)
    run.set_defaults(func=do_run)

    table = sub.add_parser("table")
    table.set_defaults(func=do_table)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
