"""Put 2.1.274's three stock compaction prompts and the plugin's own side by side.

2.1.274 does not carry one compaction prompt, it carries three, and the
full-history one is byte-identical to the 2.1.270 copy this bench has always
measured against (`bench/prompts/baseline.txt`). What is new is the other two:

- `recent274` summarises only the tail, because the engine now keeps earlier
  messages intact instead of replacing the whole conversation.
- `handoff274` writes a summary meant to sit at the *start* of a continuing
  session, with newer messages arriving after it. Its last two sections are
  "Work Completed" and "Context for Continuing Work" rather than "Current Work"
  and "Optional Next Step".

All three plus `/compact` run over one conversation, in one session, in this
order, because a compaction replaces the transcript and the arms have to see
the same thing:

    python3 bench/compare274.py run --source <transcript.jsonl> --target 20000

Each arm's full text lands in `.runs/ab/out/`; this writes one row to
`compare274.jsonl` in the verify scratch dir naming the four files, their sizes
and what each cost. `bench/compare274.py page` renders the row as HTML.

**The honest caveat, stated here because the page states it too.** `$.model.fork`
appends one user message to the whole session transcript; there is no way to
hand it only the tail. The `recent274` arm therefore reads the same
conversation the others do, so it measures what that prompt's *instructions*
produce, not what the engine's kept-tail path produces. Read it as a prompt
comparison, not as a reproduction of engine behaviour.
"""

import argparse
import html
import json
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import verify

ROWS = os.path.join(verify.SCRATCH, "compare274.jsonl")
CHECK = "compare274"

# The order is the story: what compaction was, what the engine added, what the
# plugin does instead.
ARMS = ("baseline", "recent274", "handoff274")


def seed_prompts():
    """Copy each committed variant to where `ab_fork` reads it.

    `bench/prompts/` is what git keeps; `.runs/ab/prompts/` is what the tool
    opens, and `.runs/` is ignored. A fresh clone has the prompts and no way
    for the tool to find them without this.
    """
    seeded = {}

    for label in ARMS:
        src = os.path.join(verify.PLUGIN, "bench", "prompts", f"{label}.txt")
        dst = os.path.join(verify.PLUGIN, ".runs", "ab", "prompts", f"{label}.txt")

        os.makedirs(os.path.dirname(dst), exist_ok=True)

        with open(src, encoding="utf-8") as handle:
            text = handle.read()

        with open(dst, "w", encoding="utf-8") as handle:
            handle.write(text)

        seeded[label] = len(text)

    return seeded


def cut_fixture(source, target):
    """A fresh disposable session at a given context size, in the isolated config."""
    import subprocess

    out = subprocess.run(
        [sys.executable, os.path.join(verify.PLUGIN, "bench", "fixture.py"), source, "--target", str(target)],
        capture_output=True,
        text=True,
        timeout=600,
    )

    if out.returncode != 0:
        sys.exit(f"fixture.py failed: {out.stderr.strip()}")

    session = None
    path = None

    for line in out.stdout.splitlines():
        if line.startswith("session"):
            session = line.split()[1]
        if line.startswith("file"):
            path = line.split()[1]

    if not session or not path:
        sys.exit(f"fixture.py said nothing usable:\n{out.stdout}")

    return session, path


def rehome(session, path):
    """Move the cut fixture under the config dir `--resume` will actually read."""
    fresh = str(uuid.uuid4())

    os.makedirs(verify.project_dir(CHECK), exist_ok=True)
    target = verify.transcript_of(CHECK, fresh)

    with open(path, encoding="utf-8") as src, open(target, "w", encoding="utf-8") as dst:
        for line in src:
            dst.write(line.replace(session, fresh))

    return fresh, os.path.getsize(target)


def arms_since(before):
    """Every A/B arm recorded after a mark, oldest first."""
    import runs as bench_runs

    return [row for row in bench_runs.rows()[before:] if row.get("trigger") == "ab"]


def run_arm(child, label, mark, deadline):
    """Arm one variant, wait for its own row, and return it."""
    verify.say(
        child,
        f"Use the ab_fork tool with label={label} and replicates=1, and say nothing else.",
    )
    verify.pump(child, 20)

    end = verify.time.time() + deadline

    while verify.time.time() < end:
        verify.pump(child, 5)
        found = [row for row in arms_since(mark) if row.get("label") == label]

        if found:
            return found[-1]

    return None


def read_out(file):
    """The arm's answer as it was written, or None when the arm never answered.

    An arm's path is relative to the plugin root; the plugin's own artifacts are
    stored absolute, under the data dir.
    """
    if not file:
        return None

    path = file if os.path.isabs(file) else os.path.join(verify.PLUGIN, file)

    if not os.path.isfile(path):
        return None

    with open(path, encoding="utf-8") as handle:
        return handle.read()


def do_run(args):
    # `runs.py` resolves the data dir from the environment, and this process
    # reads the arm rows itself rather than through the spawned session.
    os.environ["COMPACT_HANDOFF_DATA_DIR"] = verify.DATA

    seeded = seed_prompts()
    print("prompts seeded: " + ", ".join(f"{k} {v} chars" for k, v in seeded.items()), flush=True)

    cut, path = cut_fixture(args.source, args.target)
    session, size = rehome(cut, path)
    print(f"fixture {session} ({size:,} bytes)", flush=True)

    import runs as bench_runs

    mark = len(bench_runs.rows())
    rows_before = verify.row_count()

    env = verify.env_for(CHECK, {"COMPACT_HANDOFF_DEV": "1"})
    child = verify.spawn(session, "compare274.log", env, model=args.model)
    verify.pump(child, 45)
    verify.warm(child)

    arms = {}

    for label in ARMS:
        print(f"arm {label} ...", flush=True)
        arm = run_arm(child, label, mark, args.deadline)
        arms[label] = arm
        print(f"  {label}: {'no row' if arm is None else arm.get('outcome')}", flush=True)

    # The plugin last, because it is the one that replaces the transcript.
    print("arm plugin (/compact) ...", flush=True)
    verify.say(child, "/compact")
    verify.wait_for_rows(child, rows_before, 1, args.deadline)
    verify.quit_session(child)

    plugin_rows = verify.new_rows(rows_before)
    plugin = plugin_rows[0] if plugin_rows else None

    row = {
        "at": verify.time.strftime("%Y-%m-%dT%H:%M:%SZ", verify.time.gmtime()),
        "version": verify.claude_version(),
        "source": args.source,
        "target": args.target,
        "fixtureBytes": size,
        "session": session,
        "model": args.model,
        "promptChars": seeded,
        "arms": {
            label: None if arm is None else {
                "outcome": arm.get("outcome"),
                "chars": arm.get("chars"),
                "file": arm.get("file"),
                "usage": arm.get("usage"),
                "cost": arm.get("cost"),
                "elapsedMs": arm.get("elapsedMs"),
                "text": read_out(arm.get("file")),
            }
            for label, arm in arms.items()
        },
        "plugin": None if plugin is None else {
            "handoffChars": plugin.get("handoffChars"),
            "summaryChars": plugin.get("summaryChars"),
            "usage": plugin.get("usage"),
            "cost": plugin.get("cost"),
            "elapsedMs": plugin.get("elapsedMs"),
            "disposition": plugin.get("disposition"),
            "outcome": plugin.get("outcome"),
            "messagesOut": plugin.get("messagesOut"),
            "parts": plugin.get("parts"),
            "files": plugin.get("files"),
            # The four-part handoff as it was handed up, and the model's own
            # summary inside it: the two things the arms are comparable to.
            "handoffText": read_out((plugin.get("files") or {}).get(".md")),
            "summaryText": read_out((plugin.get("files") or {}).get(".summary.md")),
        },
    }

    os.makedirs(verify.SCRATCH, exist_ok=True)

    with open(ROWS, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")

    print(f"\nwrote {ROWS}")

    for label, arm in row["arms"].items():
        got = "nothing" if arm is None else f"{arm['chars']:,} chars, {usd(arm.get('cost'))}"
        print(f"  {label:<12} {got}")

    plug = row["plugin"]
    print(f"  {'plugin':<12} " + ("nothing" if plug is None else
                                  f"{plug.get('summaryChars') or 0:,} chars, {usd(plug.get('cost'))}"))


def usd(cost):
    if not cost or cost.get("totalUsd") is None:
        return "unpriced"

    return f"${cost['totalUsd']:.4f}"


def latest_row():
    if not os.path.isfile(ROWS):
        sys.exit(f"no rows at {ROWS}; run `compare274.py run` first")

    with open(ROWS, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]

    if not rows:
        sys.exit(f"{ROWS} is empty")

    return rows[-1]


def do_page(args):
    import page274

    row = latest_row()
    out = args.out or os.path.join(verify.SCRATCH, "compare274.html")
    page274.render(row, out)
    print(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run")
    run.add_argument("--source", required=True, help="A transcript jsonl to cut a fixture from.")
    run.add_argument("--target", type=int, default=20000, help="Context size in tokens to cut to.")
    run.add_argument("--model", default="claude-sonnet-5")
    run.add_argument("--deadline", type=int, default=400)
    run.set_defaults(func=do_run)

    page = sub.add_parser("page")
    page.add_argument("--out", default=None)
    page.set_defaults(func=do_page)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
