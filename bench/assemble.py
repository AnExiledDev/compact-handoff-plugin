"""Build the handoff a session would actually receive: model output plus the
mechanical parts, and register it as a gradeable arm.

The thing under test in Phase 3 is not a prompt, it is a DOCUMENT. Three of the
four arms run the same compaction instruction and differ only in what is stapled
on afterwards, so forking three times would price fork noise into a comparison
that has none: the model's half of B and D is byte-identical to A. One fork per
distinct PROMPT, assembled as many ways as there are arms, and the appendix
effect is measured paired, against the same words.

Each assembled document gets its own `runs.jsonl` record carrying the fork's
usage, so `grade.py`, `classes.py`, `noise.py` and `invent.py` all read it with
no changes: to them an arm is a label and a file.

The model's own text is passed through `appendix.py`'s unsourced marker on every
arm, including the one whose document does not carry the appendix, because the
tag count is a per-arm number worth comparing. On arms that do carry it the tags
are IN the graded document, which is deliberate and is a cost the grading has to
be allowed to see: a `[unsourced]` beside a fact that was true is the feature
misfiring, and it should show up as a worse score rather than be hidden.

    python3 bench/assemble.py \
        --fixture ~/.claude/projects/<project>/<session>.jsonl --lines 181 \
        --appendix /tmp/p3-appendix.md --commitments /tmp/p3-commitments.md \
        --arm armA:ledger: --arm armB:ledger:appendix \
        --arm armC:ledgerplus:appendix --arm armD:ledger:appendix+commitments
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from appendix import mark_unsourced
from grade import PLUGIN, RUNS, handoffs_from

OUT = os.path.join(PLUGIN, ".runs", "ab", "out")


def newest_by_label(labels, min_context):
    """The most recent answered fork for each prompt label."""
    picked = {}

    for record in handoffs_from(RUNS, labels, min_context):
        if record["label"] not in picked or record["at"] > picked[record["label"]]["at"]:
            picked[record["label"]] = record

    missing = [label for label in labels if label not in picked]

    if missing:
        sys.exit(f"no answered fork for: {', '.join(missing)}")

    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", required=True, help="The transcript the forks ran over, for the marker pass.")
    ap.add_argument("--lines", type=int, default=None)
    ap.add_argument("--appendix", required=True)
    ap.add_argument("--commitments", required=True)
    ap.add_argument("--arm", action="append", required=True, metavar="NAME:PROMPT:PARTS",
                    help="Arm name, the prompt label whose fork it uses, and which mechanical parts to append.")
    ap.add_argument("--min-context", type=int, default=100_000)
    args = ap.parse_args()

    arms = [spec.split(":") for spec in args.arm]

    if any(len(spec) != 3 for spec in arms):
        sys.exit("each --arm must be NAME:PROMPT:PARTS")

    forks = newest_by_label(sorted({prompt for _, prompt, _ in arms}), args.min_context)

    raw = []

    for n, line in enumerate(open(args.fixture, encoding="utf-8"), 1):
        if args.lines and n > args.lines:
            break

        raw.append(line)

    transcript = "".join(raw)
    appendix = open(args.appendix, encoding="utf-8").read().strip()
    commitments = open(args.commitments, encoding="utf-8").read().strip()

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-000Z")

    print(f"{'arm':8}{'prompt':14}{'parts':22}{'model':>9}{'doc':>9}{'tags':>6}  by kind")

    for name, prompt, parts in arms:
        fork = forks[prompt]
        body = open(os.path.join(PLUGIN, fork["file"]), encoding="utf-8").read()
        marked, counts = mark_unsourced(body, transcript)

        wanted = set(filter(None, parts.split("+")))
        document = marked if "appendix" in wanted else body

        if counts and "appendix" in wanted:
            document += ("\n\n_Marker pass: " + str(sum(counts.values())) + " specifics tagged `[unsourced]` ("
                         + ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))
                         + "). Tagged means the transcript does not contain the string, which is not proof it is false._")

        if "appendix" in wanted:
            document += "\n\n" + appendix

        if "commitments" in wanted:
            document += "\n\n" + commitments

        path = os.path.join(OUT, f"{name}-{stamp}-1.md")

        open(path, "w", encoding="utf-8").write(document)

        with open(RUNS, "a", encoding="utf-8") as runs:
            runs.write(json.dumps({
                "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "trigger": "ab",
                "label": name,
                "replicate": 1,
                "outcome": "answered",
                "file": os.path.relpath(path, PLUGIN),
                "chars": len(document),
                "usage": fork["usage"],
                "elapsedMs": fork.get("elapsedMs"),
                "aborted": False,
                "assembledFrom": fork["file"],
                "parts": sorted(wanted),
            }) + "\n")

        kinds = ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "-"

        print(f"{name:8}{prompt:14}{parts or '(none)':22}{len(body):>9,}{len(document):>9,}{sum(counts.values()):>6}  {kinds}")


if __name__ == "__main__":
    main()
