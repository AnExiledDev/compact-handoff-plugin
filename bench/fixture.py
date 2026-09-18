"""Re-home a large transcript into this worktree as a fresh, disposable session.

The original file is never opened for writing. Every `cwd` and `sessionId` is
rewritten so a resume lands in the worktree the bench runs from, and nothing in
the copy points at a directory that no longer exists.

`--target` cuts the copy down to a context size. A resumed session re-sends its
whole transcript plus this worktree's system prompt and tools, so a fixture
sized at the transcript's own high-water mark is rejected with "Prompt is too
long" before any arm can run: 157k measured that way did not fit. Cutting is a
prefix of the conversation, never a window into the middle, so the copy is
always structurally whole, and it ends on a plain assistant reply so no tool
call is left without its result.

    python3 bench/fixture.py <transcript.jsonl> --target 120000
"""

import argparse
import json
import os
import uuid

# The worktree a fixture is re-homed into is the one this copy of the plugin sits
# in, not a name typed once: bench worktrees come and go, and a resume whose cwd
# no longer exists answers "No conversation found" from anywhere.
WORKTREE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PROJECT = os.path.join(
    os.path.expanduser("~/.claude/projects"),
    "".join(c if c.isalnum() else "-" for c in WORKTREE),
)
BRANCH = os.path.basename(WORKTREE)


def context_of(record):
    """What the window held when this response was asked for, or None."""
    usage = (record.get("message") or {}).get("usage")

    if not isinstance(usage, dict):
        return None

    return (
        usage.get("input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
    )


def is_clean_end(record):
    """True where cutting leaves no tool call waiting on a result."""
    if record.get("type") != "assistant":
        return False

    content = (record.get("message") or {}).get("content")

    if not isinstance(content, list):
        return False

    return all(block.get("type") != "tool_use" for block in content)


def rehome(record, session):
    if "sessionId" in record:
        record["sessionId"] = session
    if "cwd" in record:
        record["cwd"] = WORKTREE
    if isinstance(record.get("gitBranch"), str):
        record["gitBranch"] = BRANCH

    return record


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--target", type=int, default=0, help="Stop once the context passes this many tokens. 0 keeps the whole transcript.")
    ap.add_argument("--session", default=None, help="Session id to write under. A fresh uuid4 by default.")
    args = ap.parse_args()

    session = args.session or str(uuid.uuid4())
    dst = os.path.join(PROJECT, f"{session}.jsonl")

    os.makedirs(PROJECT, exist_ok=True)

    records = []
    cut = None
    reached = 0

    for line in open(args.source, encoding="utf-8"):
        line = line.strip()

        if not line:
            continue

        try:
            record = json.loads(line)
        except Exception:
            continue

        records.append(rehome(record, session))

        held = context_of(record)

        if held is not None:
            reached = held

        if args.target and is_clean_end(record):
            cut = len(records)

            if held is not None and held >= args.target:
                break

    if args.target and cut:
        records = records[:cut]

    with open(dst, "w", encoding="utf-8") as out:
        for record in records:
            out.write(json.dumps(record) + "\n")

    print(f"session   {session}")
    print(f"file      {dst}")
    print(f"lines     {len(records):,}")
    print(f"context   ~{reached:,} tokens at the cut")
    print(f"bytes     {os.path.getsize(dst):,}")
    print(f"resume    claude --resume {session}")


if __name__ == "__main__":
    main()
