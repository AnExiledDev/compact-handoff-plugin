"""Count specifics a handoff asserts that its own source never contained.

Recall is blind to invention. An atom exists because the source contains it, so
a fact the model made up has no row and can never be marked missing; a handoff
that confabulates freely scores exactly like one that does not. That matters
most for an arm told to omit nothing, because the cheapest way to omit nothing
is to fill the gaps in.

This is the companion pass. The checker sees the source and one handoff, and
counts concrete specifics the handoff states that the source does not support.
It is a COUNT, deliberately not a penalty: it belongs next to recall so the two
can be read together, not folded into it where a single number would hide which
of the two moved.

The known example, and the reason this exists: the fixture conversation never
names a Laravel major version anywhere in its 87KB, and arms asserted both 11
and 12 regardless. The repository really is on `^12.0`, so half of them were
accidentally right about something that was never in their input.

    python3 bench/source.py <transcript> --lines 181 > /tmp/source.txt
    python3 bench/invent.py --source /tmp/source.txt --newest 3
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

from grade import GRADES, PLUGIN, RUNS, ask, handoffs_from

INVENT = os.path.join(PLUGIN, ".runs", "ab", "invent")
CLAIM = re.compile(r"^\s*CLAIM:\s*(.+?)\s*\|\s*(.+?)\s*$", re.IGNORECASE)

PROMPT = """Below is a source conversation, and then a summary someone wrote of it. Find every concrete specific the summary asserts that the source does not support.

A concrete specific is a checkable value: a number, a count, a version, a file path, a filename, an identifier, an issue or PR number, a command, a proper name, a quantity, a date. Prose, framing, emphasis and the summary's own opinions are NOT specifics and are never reported here.

Report a specific only when the source genuinely does not support it. Before you report one, work through all three:

1. **Search the whole source for it.** The summary may put a fact somewhere different, or word it differently. A fact stated in the source and restated in the summary is supported, however differently it is phrased.
2. **Check whether the source is cut where it would have been.** The source is a rendered digest: tool results and thinking blocks are truncated and marked `[... N more chars]`, and some tool outputs were persisted to a separate file and never appear at all. If the specific could plausibly have sat inside one of those cut regions, it is NOT unsupported. Say nothing about it. Only report specifics where you can see that the source had the opportunity to state it and did not.
3. **Distinguish derived from invented.** A total the summary computed by adding up numbers the source does give is supported. A rounding, a unit change, or a restatement at lower precision is supported.

What you ARE looking for is a value that appears from nowhere: the summary names a version, a count, a path or an identifier that the source never establishes and could not have, stated as though it were fact.

Output one line per finding, and nothing else:

    CLAIM: <the specific, quoted from the summary> | <why the source does not support it>

If there are none, output exactly:

    CLAIM: none | the summary asserts no specifics the source lacks

Be conservative. A false report here is worse than a missed one: this number is meant to catch a handoff filling gaps with invention, and it is useless if it also fires on ordinary faithful compression.

===== SOURCE =====
{source}

===== SUMMARY =====
{handoff}
"""


def claims_from(reply):
    found = []

    for line in reply.splitlines():
        match = CLAIM.match(line)

        if not match:
            continue

        claim, why = match.groups()

        if claim.strip().lower() == "none":
            continue

        found.append({"claim": claim[:300], "why": why[:300]})

    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="Rendered source digest from source.py.")
    ap.add_argument("--labels", nargs="*", default=[])
    ap.add_argument("--min-context", type=int, default=100_000)
    ap.add_argument("--newest", type=int, default=None)
    ap.add_argument("--model", default="claude-sonnet-5")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    source = open(args.source, encoding="utf-8").read()
    records = handoffs_from(RUNS, args.labels, args.min_context)

    if args.newest is not None:
        per_label = defaultdict(list)

        for record in records:
            per_label[record["label"]].append(record)

        records = [r for label in per_label for r in per_label[label][-args.newest:]]

    os.makedirs(INVENT, exist_ok=True)
    print(f"{len(records)} handoffs, source {len(source):,} chars, model {args.model}\n", file=sys.stderr)

    todo = []
    results = []

    for record in records:
        stem = os.path.basename(record["file"]).replace(".md", "")
        out = os.path.join(INVENT, f"{stem}.json")

        if os.path.exists(out) and not args.force:
            results.append(json.load(open(out, encoding="utf-8")))
            print(f"  cached  {stem}", file=sys.stderr)
            continue

        todo.append((record, stem, out))

    def run(job):
        record, stem, out = job
        handoff = open(os.path.join(PLUGIN, record["file"]), encoding="utf-8").read()

        try:
            reply = ask(PROMPT.format(source=source, handoff=handoff), args.model, args.timeout)
        except Exception as error:
            print(f"  FAILED  {stem}: {error}", file=sys.stderr)

            return None

        found = {"file": record["file"], "label": record["label"], "claims": claims_from(reply)}

        with open(out, "w", encoding="utf-8") as handle:
            json.dump(found, handle, indent=1)

        print(f"  checked {stem}: {len(found['claims'])} unsupported", file=sys.stderr)

        return found

    if todo:
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            results.extend(f for f in pool.map(run, todo) if f is not None)

    by_label = defaultdict(list)

    print(f"\n{'handoff':46} {'label':20} {'unsupported':>12}")

    for found in sorted(results, key=lambda f: (f["label"], f["file"])):
        by_label[found["label"]].append(len(found["claims"]))
        print(f"{os.path.basename(found['file'])[:44]:46} {found['label']:20} {len(found['claims']):>12}")

    print(f"\n{'arm':22} {'mean':>6} {'per handoff':>14}")

    for label, counts in sorted(by_label.items()):
        print(f"{label:22} {sum(counts) / len(counts):6.1f} {str(counts):>14}")

    print("\nevery unsupported specific found:")

    for found in sorted(results, key=lambda f: f["label"]):
        for claim in found["claims"]:
            print(f"  [{found['label']}] {claim['claim'][:88]}")
            print(f"      -> {claim['why'][:96]}")


if __name__ == "__main__":
    main()
