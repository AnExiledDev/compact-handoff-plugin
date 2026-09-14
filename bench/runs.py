"""Where the bench's own rows live, now that compactions moved out of the repo.

Every bench row (an A/B arm, a probe, a forced compaction, a refresh) used to be
appended to `.runs/runs.jsonl` inside the plugin, which is a shared worktree
somebody may delete. Compactions now go to `~/.claude/compact-handoff/`, and the
bench rows go beside them as `sessions/<id>/diagnostics.jsonl`, one file per
session rather than one file for the box: two sessions appending to one file is
the race the whole storage layout exists to avoid.

So "the bench's rows" is a concatenation now, not a file. The old in-repo log is
still read when it exists, because Phase 3's 82-atom grading run is in it and
re-running that costs real money.
"""

import glob
import json
import os

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEGACY = os.path.join(PLUGIN, ".runs", "runs.jsonl")
DEFAULT_DATA_DIR = os.path.join(os.path.expanduser("~"), ".claude", "compact-handoff")


def data_dir():
    return os.environ.get("COMPACT_HANDOFF_DATA_DIR") or DEFAULT_DATA_DIR


def diagnostics_files():
    """Every session's bench log, live and rehearsed, plus the legacy one."""
    root = data_dir()
    files = sorted(
        glob.glob(os.path.join(root, "sessions", "*", "diagnostics.jsonl"))
        + glob.glob(os.path.join(root, "rehearsals", "*", "diagnostics.jsonl"))
    )

    if os.path.isfile(LEGACY):
        files.append(LEGACY)

    return files


def rows():
    """Every bench row, oldest first, skipping anything unparseable."""
    found = []

    for path in diagnostics_files():
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()

                if not line:
                    continue

                try:
                    found.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

    found.sort(key=lambda row: row.get("at") or "")

    return found


def count():
    """How many rows exist right now, for waiting on an arm to record itself."""
    return len(rows())
