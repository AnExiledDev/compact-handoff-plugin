"""Lay the arms out for a judge without telling it which arm is which.

A judge that can see the labels is scoring the labels. So each replicate round
becomes its own packet holding one answer from every arm under a letter, the
order shuffled per packet, and the key is written somewhere the judge is never
pointed at. Comparing within a round rather than across all of them is
deliberate: the arms in one round were asked of the same context, so a round is
a paired comparison and the noise between rounds cancels instead of counting.

    python3 bench/blind.py --labels baseline ultrathink doublecheck
"""

import argparse
import json
import os
import random
import shutil
from collections import defaultdict

import runs as bench_runs

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLIND = os.path.join(PLUGIN, ".runs", "ab", "blind")
LETTERS = "ABCDEFGH"


def arms(labels, min_context):
    """Every answered arm in the order it ran, grouped by label."""
    found = defaultdict(list)

    for record in bench_runs.rows():
        if record.get("trigger") != "ab" or record.get("outcome") != "answered":
            continue

        if record.get("label") not in labels:
            continue

        read = (record.get("usage") or {}).get("cache_read_input_tokens", 0)

        if read < min_context:
            continue

        found[record["label"]].append(record)

    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", nargs="+", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--min-context", type=int, default=100_000, help="Ignore arms run against a smaller context: those are plumbing tests.")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    found = arms(args.labels, args.min_context)

    for label in args.labels:
        if len(found[label]) < args.rounds:
            raise SystemExit(f"{label} has {len(found[label])} answered arms over {args.min_context:,} context, need {args.rounds}")

    # The newest N, because an arm added later is the one that was just run and
    # the arms of one round sit next to each other in the log.
    found = {label: runs[-args.rounds:] for label, runs in found.items()}

    rng = random.Random(args.seed)

    shutil.rmtree(BLIND, ignore_errors=True)
    os.makedirs(BLIND)

    key = {}

    for round_no in range(args.rounds):
        packet = os.path.join(BLIND, f"round-{round_no + 1}")
        os.makedirs(packet)

        order = list(args.labels)
        rng.shuffle(order)

        for letter, label in zip(LETTERS, order):
            record = found[label][round_no]
            src = os.path.join(PLUGIN, record["file"])

            shutil.copyfile(src, os.path.join(packet, f"{letter}.md"))

            key[f"round-{round_no + 1}/{letter}"] = {
                "label": label,
                "file": record["file"],
                "chars": record.get("chars"),
                "elapsedMs": record.get("elapsedMs"),
                "usage": record.get("usage"),
            }

        print(f"round-{round_no + 1}: " + ", ".join(f"{l}={'?'}" for l in LETTERS[: len(order)]))

    with open(os.path.join(PLUGIN, ".runs", "ab", "key.json"), "w", encoding="utf-8") as out:
        json.dump(key, out, indent=1)

    print(f"\npackets in {BLIND}")
    print(f"key      {os.path.join(PLUGIN, '.runs', 'ab', 'key.json')}  (do not show a judge)")


if __name__ == "__main__":
    main()
