"""Grade handoffs against a ground-truth checklist built from the source.

The judge this replaces scored taste: five dimensions, 1-10, one opinion per
round. It ranked four arms inside a 1.33-point band while a single arm varied by
4 points across its own replicates, which is a way of saying it measured
nothing. Worse, one of its dimensions actively penalised length, and the thing
being optimised for is whether a successor session can continue the work, not
whether the document is pleasant.

So: enumerate what the source conversation actually contains, once, as atoms.
Then ask, per atom, whether a given handoff carries it. That is recall against a
fixed denominator, it does not care how long the document is, and two handoffs
graded a week apart are comparable because the checklist did not move.

The grader never sees the source and never sees which arm produced what. It sees
one handoff and the checklist. That makes it cheap and it makes it blind.

    python3 bench/grade.py --checklist <checklist.md>

Add --repeat 2 to grade each handoff twice: the spread between the two is the
grader's own noise, which has to be small relative to the fork-to-fork spread
before any of the arm differences mean anything.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import runs as bench_runs

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRADES = os.path.join(PLUGIN, ".runs", "ab", "grades")
INVENT = os.path.join(PLUGIN, ".runs", "ab", "invent")

POINTS = {"present": 1.0, "partial": 0.5, "absent": 0.0, "wrong": -1.0}
ROW = re.compile(r"^\|\s*(A\d+)\s*\|\s*([a-z-]+)\s*\|\s*(.*?)\s*\|\s*([^|]*?)\s*\|\s*$")
VERDICT = re.compile(r"^\s*(A\d+)\s+(present|partial|absent|wrong)\b\s*(.*)$", re.IGNORECASE)

PROMPT = """You are grading one handoff summary against a checklist of facts taken from the conversation it summarises. You have not seen that conversation and you must not try to guess at it: the checklist IS the ground truth here. Judge only whether the handoff carries each fact.

For every checklist row, decide one verdict:

- `present` - a successor reading only the handoff would come away knowing this fact. Wording may differ completely; paraphrase is fine, and so is the fact appearing somewhere other than where you would expect it. Being stated more briefly than the checklist states it is still present.
- `partial` - the handoff gestures at the fact but a successor would still have to ask or rediscover something. Use this when a decision is given with no reason, an identifier is described but not named, a command is mentioned but not quoted, or one half of a two-part fact is missing.
- `absent` - not in the handoff in any form.
- `wrong` - the handoff states a DIFFERENT VALUE for this fact than the checklist does. Both values must exist and they must conflict: 14 against 20, `Entry.php` against `Release.php`, "the user approved" against "the user rejected".

`wrong` has a hard test, and it is the only thing that separates it from `partial`: **you must be able to name the handoff's value and the checklist's value, and they must be different.** Write them both in the note, as `handoff says X, checklist says Y`. If you cannot fill in both X and Y with something concrete, the verdict is NOT `wrong`.

Everything the handoff merely leaves out is `partial` or `absent`, never `wrong`. A row where the handoff carries part of the fact and omits the rest is `partial`. A row where the handoff is less detailed, less hedged, shorter, or frames the fact differently is `present` or `partial`. Omission is never a contradiction. If your note would contain the words "omits", "does not mention", "lacks" or "incomplete", you have picked the wrong verdict.

Output one line per checklist row and nothing else. No preamble, no summary, no totals.

Format: `<id> <verdict>` and then, ONLY for `partial` and `wrong`, up to twelve words saying what is missing or what conflicts.

    A01 present
    A02 partial no reason given for the choice
    A03 absent
    A04 wrong handoff says 14 directories, checklist says 20

Grade every row. Do not skip any. Do not invent ids.

===== CHECKLIST =====
{checklist}

===== HANDOFF =====
{handoff}
"""


def atoms_from(path):
    """Parse the checklist table. Rows outside the table shape are ignored."""
    found = []

    for line in open(path, encoding="utf-8"):
        match = ROW.match(line.rstrip("\n"))

        if not match:
            continue

        ident, klass, text, source = match.groups()

        found.append({"id": ident, "class": klass, "atom": text.replace("\\|", "|"), "source": source})

    return found


def handoffs_from(labels, min_context):
    """Every answered arm big enough to be a real run, with its label kept aside."""
    found = []

    for record in bench_runs.rows():
        if record.get("trigger") != "ab" or record.get("outcome") != "answered":
            continue

        if labels and record.get("label") not in labels:
            continue

        if (record.get("usage") or {}).get("cache_read_input_tokens", 0) < min_context:
            continue

        found.append(record)

    return found


def ask(prompt, model, timeout):
    """One headless grading call. Run from a neutral cwd so no project's
    CLAUDE.md is loaded into the grader and no MCP server is started."""
    result = subprocess.run(
        ["claude", "-p", "--model", model, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=os.path.expanduser("~"),
    )

    if result.returncode != 0:
        raise RuntimeError(f"grader exited {result.returncode}: {result.stderr[-500:]}")

    return result.stdout


def verdicts_from(reply, wanted):
    """Pull verdicts out of the reply, keeping only ids the checklist defines."""
    found = {}

    for line in reply.splitlines():
        match = VERDICT.match(line)

        if not match:
            continue

        ident, verdict, note = match.groups()

        if ident in wanted:
            found[ident] = {"verdict": verdict.lower(), "note": note.strip()[:120]}

    return found


def grade_one(record, atoms, checklist_text, model, timeout, attempt):
    path = os.path.join(PLUGIN, record["file"])
    handoff = open(path, encoding="utf-8").read()

    reply = ask(PROMPT.format(checklist=checklist_text, handoff=handoff), model, timeout)
    graded = verdicts_from(reply, {a["id"] for a in atoms})

    missing = [a["id"] for a in atoms if a["id"] not in graded]

    return {
        "file": record["file"],
        "label": record["label"],
        "attempt": attempt,
        "model": model,
        "chars": record.get("chars"),
        "ungraded": missing,
        "verdicts": graded,
    }


def score_of(graded, atoms):
    """Recall ignores the penalty; net applies it. Both, because they answer
    different questions: how much did it carry, and did it also lie."""
    counts = defaultdict(int)

    for atom in atoms:
        counts[graded["verdicts"].get(atom["id"], {}).get("verdict", "absent")] += 1

    total = len(atoms)
    recall = (counts["present"] + 0.5 * counts["partial"]) / total
    net = (counts["present"] + 0.5 * counts["partial"] - counts["wrong"]) / total

    return {"recall": recall, "net": net, "counts": dict(counts)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checklist", required=True)
    ap.add_argument("--labels", nargs="*", default=[])
    ap.add_argument("--min-context", type=int, default=100_000)
    ap.add_argument("--newest", type=int, default=None, help="Keep only the newest N per label, matching blind.py's rounds.")
    ap.add_argument("--model", default="claude-sonnet-5")
    ap.add_argument("--repeat", type=int, default=1, help="Grade each handoff N times to measure the grader's own noise.")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--jobs", type=int, default=4, help="Concurrent grading calls. Each is a claude subprocess; keep it modest, this box OOMs.")
    ap.add_argument("--force", action="store_true", help="Regrade handoffs that already have a saved grade.")
    args = ap.parse_args()

    atoms = atoms_from(args.checklist)

    if not atoms:
        raise SystemExit(f"no checklist rows parsed out of {args.checklist}")

    checklist_text = "\n".join(f"| {a['id']} | {a['class']} | {a['atom']} |" for a in atoms)
    records = handoffs_from(args.labels, args.min_context)

    if args.newest is not None:
        per_label = defaultdict(list)

        for record in records:
            per_label[record["label"]].append(record)

        records = [r for label in per_label for r in per_label[label][-args.newest:]]

    if not records:
        raise SystemExit("no answered arms matched")

    os.makedirs(GRADES, exist_ok=True)
    print(f"{len(atoms)} atoms, {len(records)} handoffs, {args.repeat} pass(es), model {args.model}\n", file=sys.stderr)

    results = []
    todo = []

    for record in records:
        for attempt in range(1, args.repeat + 1):
            stem = os.path.basename(record["file"]).replace(".md", "")
            out = os.path.join(GRADES, f"{stem}-p{attempt}.json")

            if os.path.exists(out) and not args.force:
                results.append(json.load(open(out, encoding="utf-8")))
                print(f"  cached  {stem} p{attempt}", file=sys.stderr)
                continue

            todo.append((record, attempt, stem, out))

    def run(job):
        record, attempt, stem, out = job

        try:
            graded = grade_one(record, atoms, checklist_text, args.model, args.timeout, attempt)
        except Exception as error:
            print(f"  FAILED  {stem} p{attempt}: {error}", file=sys.stderr)

            return None

        with open(out, "w", encoding="utf-8") as handle:
            json.dump(graded, handle, indent=1)

        note = f" ({len(graded['ungraded'])} ungraded)" if graded["ungraded"] else ""
        print(f"  graded  {stem} p{attempt}{note}", file=sys.stderr)

        return graded

    if todo:
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            results.extend(g for g in pool.map(run, todo) if g is not None)

    report(results, atoms)


def invented_for(path):
    """How many unsupported specifics invent.py found, or None if it never ran.

    A count, never folded into recall: the two answer different questions and a
    single number would hide which of them moved."""
    stem = os.path.basename(path).replace(".md", "")
    saved = os.path.join(INVENT, f"{stem}.json")

    if not os.path.exists(saved):
        return None

    return len(json.load(open(saved, encoding="utf-8"))["claims"])


def report(results, atoms):
    by_label = defaultdict(list)
    invented = defaultdict(list)

    print(f"\n{'handoff':46} {'label':20} {'recall':>7} {'net':>7}  pres/part/abs/wrong  {'made-up':>7}")

    for graded in sorted(results, key=lambda g: (g["label"], g["file"], g.get("attempt", 1))):
        score = score_of(graded, atoms)
        by_label[graded["label"]].append(score)
        c = score["counts"]
        stem = os.path.basename(graded["file"])[:44]
        made_up = invented_for(graded["file"])

        if made_up is not None and graded.get("attempt", 1) == 1:
            invented[graded["label"]].append(made_up)

        print(f"{stem:46} {graded['label']:20} {score['recall']:6.1%} {score['net']:6.1%}"
              f"  {c.get('present',0):>3}/{c.get('partial',0):>3}/{c.get('absent',0):>3}/{c.get('wrong',0):>3}"
              f"  {'-' if made_up is None else made_up:>7}")

    print(f"\n{'arm':22} {'mean recall':>12} {'spread':>8} {'mean net':>9} {'made-up':>8}   per-handoff recall")

    for label, scores in sorted(by_label.items()):
        recalls = [s["recall"] for s in scores]
        spread = max(recalls) - min(recalls)
        made = invented.get(label)
        shown = f"{sum(made) / len(made):.1f}" if made else "-"

        print(f"{label:22} {sum(recalls) / len(recalls):11.1%} {spread:7.1%} "
              f"{sum(s['net'] for s in scores) / len(scores):8.1%} {shown:>8}   "
              + ", ".join(f"{r:.1%}" for r in recalls))

    misses(results, atoms)


def misses(results, atoms):
    """Which atom classes go missing, because that is what steers the next variant."""
    by_class = defaultdict(lambda: defaultdict(int))
    by_atom = defaultdict(int)

    for graded in results:
        for atom in atoms:
            verdict = graded["verdicts"].get(atom["id"], {}).get("verdict", "absent")
            by_class[atom["class"]][verdict] += 1

            if verdict in ("absent", "partial"):
                by_atom[atom["id"]] += 1

    print(f"\n{'class':14} {'n':>4} {'carried':>8}   (present + half credit for partial)")

    rows = []

    for klass, counts in by_class.items():
        total = sum(counts.values())
        carried = (counts["present"] + 0.5 * counts["partial"]) / total
        rows.append((carried, klass, total))

    for carried, klass, total in sorted(rows):
        print(f"{klass:14} {total:>4} {carried:7.1%}")

    print("\nmost-missed atoms (absent or partial, out of {} gradings):".format(len(results)))

    lookup = {a["id"]: a for a in atoms}

    for ident, count in sorted(by_atom.items(), key=lambda kv: -kv[1])[:12]:
        print(f"  {count:>2}x {ident} [{lookup[ident]['class']}] {lookup[ident]['atom'][:96]}")


if __name__ == "__main__":
    main()
