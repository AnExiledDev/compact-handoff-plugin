"""Split the measured spread into the grader's noise and the fork's noise.

The per-arm spread printed by grade.py is not the fork-to-fork noise floor: it
is computed over every grading, so it mixes two different things. Grading the
same document twice gives different numbers, and forking the same context twice
gives different documents. Only the second is what an arm has to beat, and only
the second answers whether one replicate is enough to screen a variant.

So: average the passes to get one recall per handoff, and the disagreement
between those passes is the grader. The spread of the handoff means inside one
arm is the fork.

    python3 bench/noise.py --checklist <checklist.md>
"""

import argparse
import glob
import json
import math
import os
import statistics
from collections import defaultdict

from grade import GRADES, atoms_from, score_of


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checklist", required=True)
    args = ap.parse_args()

    atoms = atoms_from(args.checklist)
    passes = defaultdict(dict)
    labels = {}

    for path in sorted(glob.glob(os.path.join(GRADES, "*.json"))):
        graded = json.load(open(path, encoding="utf-8"))
        passes[graded["file"]][graded.get("attempt", 1)] = score_of(graded, atoms)["recall"]
        labels[graded["file"]] = graded["label"]

    print(f"{'handoff':44} {'label':20} {'p1':>6} {'p2':>6} {'mean':>6} {'|p1-p2|':>8}")

    gaps = []
    by_label = defaultdict(list)

    for file, seen in sorted(passes.items(), key=lambda kv: (labels[kv[0]], kv[0])):
        values = [seen[k] for k in sorted(seen)]
        mean = sum(values) / len(values)
        gap = max(values) - min(values) if len(values) > 1 else None

        by_label[labels[file]].append(mean)

        if gap is not None:
            gaps.append(gap)

        shown = [f"{v:5.1%}" for v in values] + ["     "] * (2 - len(values))

        print(f"{os.path.basename(file)[:42]:44} {labels[file]:20} {shown[0]} {shown[1]} "
              f"{mean:5.1%} {'' if gap is None else f'{gap:7.1%}'}")

    print(f"\n--- grader noise: the same document scored twice ---")
    print(f"  mean |p1-p2|   {statistics.mean(gaps):.1%}")
    print(f"  max  |p1-p2|   {max(gaps):.1%}")
    print(f"  median         {statistics.median(gaps):.1%}   over {len(gaps)} document(s)")

    print(f"\n--- fork noise: different documents from one arm, passes averaged ---")
    print(f"{'arm':22} {'mean':>7} {'spread':>8} {'sd':>7}   per-handoff")

    spreads = []
    arm_means = []

    for label, means in sorted(by_label.items()):
        spread = max(means) - min(means)
        spreads.append(spread)
        arm_means.append(sum(means) / len(means))

        sd = statistics.stdev(means) if len(means) > 1 else 0.0

        print(f"{label:22} {sum(means) / len(means):6.1%} {spread:7.1%} {sd:6.1%}   "
              + ", ".join(f"{m:.1%}" for m in means))

    print(f"\n  mean fork spread within an arm   {statistics.mean(spreads):.1%}")
    print(f"  range of arm means               {max(arm_means) - min(arm_means):.1%}")

    # For two independent readings of one document, E|p1-p2| = 2*sigma/sqrt(pi),
    # so the mean absolute gap recovers the grader's own standard deviation. A
    # handoff mean averages two of those, which shrinks it by sqrt(2). Whatever
    # within-arm spread is left over that is the fork actually varying.
    grader_sd = statistics.mean(gaps) / (2 / math.sqrt(math.pi))
    grader_in_mean = grader_sd / math.sqrt(2)

    observed = [statistics.stdev(m) for m in by_label.values() if len(m) > 1]
    pooled = math.sqrt(statistics.mean(v ** 2 for v in observed))
    fork_var = pooled ** 2 - grader_in_mean ** 2
    fork_sd = math.sqrt(fork_var) if fork_var > 0 else 0.0

    print(f"\n--- where the spread actually comes from ---")
    print(f"  grader sd, one reading           {grader_sd:.1%}")
    print(f"  grader sd, mean of two readings  {grader_in_mean:.1%}")
    print(f"  observed within-arm sd (pooled)  {pooled:.1%}")
    print(f"  implied fork-only sd             {fork_sd:.1%}")

    if fork_sd < grader_in_mean:
        print("  The grader moves more than the fork does. Replicating the fork buys")
        print("  little; replicating the GRADING buys more, and a grading pass is far")
        print("  cheaper than a fork ($0.04 against ~$1.25).")

    print(f"\n--- can one replicate screen a variant? ---")

    floor = statistics.mean(spreads)
    signal = max(arm_means) - min(arm_means)

    print(f"  A single fork lands anywhere in a {floor:.1%} band.")
    print(f"  The four arms tested span {signal:.1%}.")

    if signal <= floor:
        print("  So n=1 cannot separate these arms: the noise is as big as the effect.")
        print(f"  A variant would have to beat baseline by more than {floor:.1%} to be visible in one run.")
    else:
        print("  The arm range exceeds the single-fork band, so n=1 screening is defensible")
        print(f"  for differences larger than {floor:.1%}, and blind to anything smaller.")


if __name__ == "__main__":
    main()
