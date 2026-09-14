"""What the engine's own compaction costs, measured rather than estimated.

The plugin's cost per compaction only means something next to the thing it
replaced, so this runs both arms over one conversation, in one session, in this
order:

1. `ab_fork baseline`, which sends Claude Code's own stock compaction prompt
   (`bench/prompts/baseline.txt`, lifted from 2.1.270) through the same
   `$.model.fork` the plugin uses. Same conversation, same model, same cache
   state. Its usage is priced off the plugin's own table, so the two numbers
   cannot be priced differently.
2. `/compact`, which is the plugin doing the whole job: fork, ledger, state,
   commitments.

Order matters and is not a preference: a compaction replaces the conversation,
so the baseline arm has to run first. The two arms therefore see conversations
that differ by the `/compact` turn itself, which is a few hundred characters
against a fixture measured in tens of thousands of tokens.

What this does NOT measure is any engine-side work outside that model call. It
is the compaction call, on this conversation, at this size, and that is the
number the README compares.

    python3 bench/baseline.py --source <transcript.jsonl> \\
        --target 20000 --label small

Each run appends one row to `baseline.jsonl` in the verify scratch dir, and
`--table` prints every row it finds.
"""

import argparse
import json
import os
import subprocess
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import verify

ROWS = os.path.join(verify.SCRATCH, "baseline.jsonl")
CHECK = "baseline"


def seed_prompt():
    """Put the stock prompt where `ab_fork` reads it, which is not where git keeps it.

    The committed copy is `bench/prompts/baseline.txt`; `ab_fork` reads
    `.runs/ab/prompts/<label>.txt`, and `.runs/` is gitignored. A fresh clone
    therefore has the prompt and no way for the tool to find it, which would
    make this measurement unreproducible by anybody but the machine that ran it.
    """
    src = os.path.join(verify.PLUGIN, "bench", "prompts", "baseline.txt")
    dst = os.path.join(verify.PLUGIN, ".runs", "ab", "prompts", "baseline.txt")

    os.makedirs(os.path.dirname(dst), exist_ok=True)

    with open(src, encoding="utf-8") as handle:
        text = handle.read()

    with open(dst, "w", encoding="utf-8") as handle:
        handle.write(text)

    return len(text)


def cut_fixture(source, target):
    """A fresh disposable session at a given context size, in the isolated config."""
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
    """Every A/B arm recorded after a mark, newest last."""
    import runs as bench_runs

    return [row for row in bench_runs.rows()[before:] if row.get("trigger") == "ab"]


def do_run(args):
    # `runs.py` resolves the data dir from the environment, and this process
    # reads the arm rows itself rather than through the spawned session. Without
    # this it would count arms in the operator's real data dir instead.
    os.environ["COMPACT_HANDOFF_DATA_DIR"] = verify.DATA

    print(f"stock prompt seeded, {seed_prompt()} chars")

    cut, path = cut_fixture(args.source, args.target)
    session, size = rehome(cut, path)

    import runs as bench_runs

    arms_before = len(bench_runs.rows())
    rows_before = verify.row_count()

    env = verify.env_for(CHECK, {"COMPACT_HANDOFF_DEV": "1"})
    child = verify.spawn(session, "baseline.log", env, model=args.model)
    verify.pump(child, 45)
    verify.warm(child)

    verify.say(
        child,
        "Use the ab_fork tool with label=baseline and replicates=1, and say nothing else.",
    )
    verify.pump(child, 20)

    # The arm runs at turn.complete, so the wait is on the arm's own row.
    end = verify.time.time() + args.deadline
    arm = None

    while verify.time.time() < end:
        verify.pump(child, 5)
        found = arms_since(arms_before)

        if found:
            arm = found[-1]
            break

    verify.say(child, "/compact")
    verify.wait_for_rows(child, rows_before, 1, args.deadline)
    verify.quit_session(child)

    plugin_rows = verify.new_rows(rows_before)
    plugin = plugin_rows[0] if plugin_rows else None

    row = {
        "at": verify.time.strftime("%Y-%m-%dT%H:%M:%SZ", verify.time.gmtime()),
        "label": args.label,
        "source": args.source,
        "target": args.target,
        "fixtureBytes": size,
        "session": session,
        "model": args.model,
        "baseline": None if arm is None else {
            "chars": arm.get("chars"),
            "usage": arm.get("usage"),
            "cost": arm.get("cost"),
            "costUnknownReason": arm.get("costUnknownReason"),
            "elapsedMs": arm.get("elapsedMs"),
            "outcome": arm.get("outcome"),
        },
        "plugin": None if plugin is None else {
            "handoffChars": plugin.get("handoffChars"),
            "summaryChars": plugin.get("summaryChars"),
            "usage": plugin.get("usage"),
            "cost": plugin.get("cost"),
            "costUnknownReason": plugin.get("costUnknownReason"),
            "elapsedMs": plugin.get("elapsedMs"),
            "disposition": plugin.get("disposition"),
            "parts": plugin.get("parts"),
        },
    }

    os.makedirs(verify.SCRATCH, exist_ok=True)

    with open(ROWS, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")

    print(json.dumps(row, indent=2))


def usd(cost):
    if not cost or cost.get("totalUsd") is None:
        return "unpriced"

    return f"${cost['totalUsd']:.4f}"


def do_table(_args):
    if not os.path.isfile(ROWS):
        print("no baseline rows yet")
        return

    print("| size | fixture bytes | engine compaction | plugin compaction | plugin fork | commitments | ratio |")
    print("|------|---------------|-------------------|-------------------|-------------|-------------|-------|")

    for line in open(ROWS, encoding="utf-8"):
        line = line.strip()

        if not line:
            continue

        row = json.loads(line)
        base = (row.get("baseline") or {}).get("cost")
        plug = (row.get("plugin") or {}).get("cost")
        parts = (row.get("plugin") or {}).get("parts") or {}
        ratio = "-"

        if base and plug and base.get("totalUsd"):
            ratio = f"{plug['totalUsd'] / base['totalUsd']:.2f}x"

        fork = f"${plug['forkUsd']:.4f}" if plug and plug.get("forkUsd") is not None else "unpriced"
        commit = parts.get("commitmentsCostUsd")
        commit = f"${commit:.4f}" if isinstance(commit, (int, float)) else "-"

        print(
            f"| {row['label']} | {row['fixtureBytes']:,} | {usd(base)} | {usd(plug)} "
            f"| {fork} | {commit} | {ratio} |"
        )

    print("\nPrices are the plugin's own table, taken 2026-09-14. Each row's model is in baseline.jsonl.")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run")
    run.add_argument("--source", required=True, help="A transcript jsonl to cut a fixture from.")
    run.add_argument("--target", type=int, required=True, help="Context size in tokens to cut to.")
    run.add_argument("--label", required=True, help="What to call this size in the table.")
    run.add_argument("--model", default="claude-sonnet-5")
    run.add_argument("--deadline", type=int, default=400)
    run.set_defaults(func=do_run)

    table = sub.add_parser("table")
    table.set_defaults(func=do_table)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
