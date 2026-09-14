"""Break recall down by atom class, per arm, and track specific atoms across arms.

grade.py prints one carry rate per class pooled over every arm, which answers
"what does compaction lose" but not "did this variant fix it". An arm is written
to target a weakness - a ledger section for rejected approaches and session
state, verbatim quoting for user constraints - so the number that judges it is
that class in that arm, not the mean of all four.

`--atoms` follows named atoms instead: the ones nothing carried last time, so a
variant that finally reaches one is visible as more than a decimal point on a
mean. It prints the best verdict any grading pass gave, because the question is
whether the arm carried the fact at all.

    python3 bench/classes.py --checklist <checklist.md> \
        --labels ledger baseline noomission verbatim --since 2026-09-14T05-
"""

import argparse
import glob
import json
import os
import re
from collections import defaultdict

from grade import GRADES, POINTS, atoms_from

# Half credit for a partial, and a `wrong` carries nothing. This is the recall
# scale, not the net one: net's penalty belongs on a whole document, where it
# says the handoff lied, and not on a class, where one negative would read as
# the class being carried worse than silence.
CARRIED = {**POINTS, "wrong": 0.0}


def gradings(labels, since):
    for path in sorted(glob.glob(os.path.join(GRADES, "*.json"))):
        graded = json.load(open(path, encoding="utf-8"))

        if labels and graded["label"] not in labels:
            continue

        if since and since not in graded["file"]:
            continue

        yield graded


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checklist", required=True)
    ap.add_argument("--labels", nargs="*", default=[])
    ap.add_argument("--since", default=None, help="Substring of the handoff filename, so one round can be read alone.")
    ap.add_argument("--atoms", nargs="*", default=[], help="Atom ids to follow individually.")
    args = ap.parse_args()

    atoms = atoms_from(args.checklist)
    classes = {atom["id"]: atom["class"] for atom in atoms}
    text = {atom["id"]: atom["atom"] for atom in atoms}

    scored = defaultdict(lambda: defaultdict(lambda: [0.0, 0]))
    per_atom = defaultdict(lambda: defaultdict(list))
    counted = defaultdict(int)

    for graded in gradings(args.labels, args.since):
        counted[graded["label"]] += 1

        for atom_id, atom_class in classes.items():
            verdict = graded["verdicts"].get(atom_id, {}).get("verdict", "absent")

            scored[graded["label"]][atom_class][0] += CARRIED.get(verdict, 0.0)
            scored[graded["label"]][atom_class][1] += 1
            per_atom[atom_id][graded["label"]].append(verdict)

    arms = sorted(scored)

    if not arms:
        raise SystemExit("no gradings matched")

    print("gradings per arm: " + ", ".join(f"{arm} {counted[arm]}" for arm in arms) + "\n")

    order = sorted({c for c in classes.values()}, key=lambda c: sum(scored[a][c][0] / max(scored[a][c][1], 1) for a in arms))

    print(f"{'class':12}{'n':>5}" + "".join(f"{arm:>13}" for arm in arms))

    for atom_class in order:
        cells = "".join(f"{scored[arm][atom_class][0] / scored[arm][atom_class][1]:>12.1%} " for arm in arms)

        print(f"{atom_class:12}{scored[arms[0]][atom_class][1]:>5}{cells}")

    if not args.atoms:
        return

    print(f"\nbest verdict any pass gave, per arm\n")
    print(f"{'atom':6}{'class':11}" + "".join(f"{arm:>13}" for arm in arms) + "  what it is")

    for atom_id in args.atoms:
        cells = []

        for arm in arms:
            seen = per_atom[atom_id][arm]
            best = max(seen, key=lambda v: CARRIED.get(v, 0.0)) if seen else "-"

            cells.append(f"{best:>13}")

        print(f"{atom_id:6}{classes.get(atom_id, '?'):11}" + "".join(cells) + f"  {text.get(atom_id, '')[:60]}")


if __name__ == "__main__":
    main()
