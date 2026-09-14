"""Ask one session's context the same question under several compaction instructions.

A fork neither writes the transcript nor the prompt cache, so N variants can be
asked of one identical context, in one session, paying cache reads and nothing
else. That is the whole reason this is a bench rather than N compactions: the
arms differ only in the instruction, and no arm can disturb the next.

    python3 bench/run.py --session <id> baseline terse
    python3 bench/run.py --fresh --replicates 1 baseline

`--session` resumes a fixture (see fixture.py); `--fresh` starts an empty one,
which is the cheap way to test the plumbing and tells you nothing about a
handoff. Answers land in `.runs/ab/out/`, one file per replicate, and every run
appends a record carrying the label, usage and elapsed ms to that session's
`diagnostics.jsonl` under the plugin's data dir (see runs.py).

Auto-compaction is off for the whole run: a fixture sitting near the window
would otherwise compact itself out from under the arms still to come.
"""

import argparse
import os
import shutil
import sys
import time

import pexpect

import runs as bench_runs

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKTREE = os.path.dirname(os.path.dirname(PLUGIN))
PROMPTS = os.path.join(PLUGIN, "bench", "prompts")
STAGED = os.path.join(PLUGIN, ".runs", "ab", "prompts")

# Every arm is asked with these exact words, so the context an arm forks over is
# the context the previous arm forked over plus one identical pair of turns.
TURN = "Use the ab_fork tool with label={label} and replicates={replicates}. Do nothing else, and reply with one word."


def stage(labels):
    os.makedirs(STAGED, exist_ok=True)

    for label in labels:
        src = os.path.join(PROMPTS, f"{label}.txt")

        if not os.path.isfile(src):
            sys.exit(f"no variant at {src}")

        shutil.copyfile(src, os.path.join(STAGED, f"{label}.txt"))


def spawn(session, log_path):
    argv = ["--plugin-dir", str(PLUGIN), "--permission-mode", "bypassPermissions"]

    if session:
        argv += ["--resume", session]

    env = dict(os.environ)
    env["DISABLE_AUTO_COMPACT"] = "1"
    env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"] = "1"

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
    child.logfile_read = open(log_path, "w", buffering=1)

    return child


def pump(child, seconds):
    end = time.time() + seconds

    while time.time() < end:
        try:
            child.expect([pexpect.TIMEOUT], timeout=2)
        except pexpect.EOF:
            return


def say(child, text):
    child.send(text)
    pump(child, 2)
    child.send("\r")


def records():
    return bench_runs.count()


def wait_for(child, before, wanted, deadline):
    """Wait on the arm's own records rather than a guess at how long it takes.

    A fork over a large context took 136 s once measured, and a replicate is
    another one after it, so any fixed settle is either wrong or wasteful.
    """
    end = time.time() + deadline

    while time.time() < end:
        pump(child, 5)

        done = records() - before

        if done >= wanted:
            return done

    return records() - before


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("labels", nargs="+")
    ap.add_argument("--session", default=None, help="Resume this session id as the fixture.")
    ap.add_argument("--fresh", action="store_true", help="Start an empty session instead.")
    ap.add_argument("--replicates", type=int, default=3)
    ap.add_argument("--deadline", type=int, default=400, help="Seconds to allow per replicate before giving up on an arm.")
    ap.add_argument("--log", default="/tmp/ab-tty.log")
    args = ap.parse_args()

    if not args.session and not args.fresh:
        sys.exit("pass --session <id> or --fresh")

    stage(args.labels)

    child = spawn(args.session, args.log)
    pump(child, 45 if args.session else 15)

    for label in args.labels:
        print(f"-- {label} x{args.replicates}", flush=True)

        before = records()

        say(child, TURN.format(label=label, replicates=args.replicates))

        done = wait_for(child, before, args.replicates, args.deadline * args.replicates)

        print(f"   {done}/{args.replicates} recorded", flush=True)

    child.send("\x1b")
    pump(child, 2)
    child.send("/quit\r")
    pump(child, 5)
    child.close(force=True)

    print(f"done; tty log at {args.log}")


if __name__ == "__main__":
    main()
