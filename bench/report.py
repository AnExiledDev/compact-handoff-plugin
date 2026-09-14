"""Tabulate what each arm of the bench cost and produced.

Reads the bench's rows (see runs.py) and prints one block per label, every replicate under
it. The numbers here are the cheap half of scoring: length, output tokens,
wall clock and money. Whether a handoff is any *good* is not in this file and
cannot be, because that is judged by reading the arms' answers in
`.runs/ab/out/` or by putting a fixed question set to each of them.

Rates default to Opus 5 list prices in dollars per million tokens. Override
them when an arm ran on another model, because the fork uses whatever model the
fixture session is on.
"""

import argparse
from collections import defaultdict

import runs as bench_runs


def cost(usage, rates):
    if not usage:
        return 0.0

    return (
        usage.get("input_tokens", 0) * rates["input"]
        + usage.get("cache_read_input_tokens", 0) * rates["cache_read"]
        + usage.get("cache_creation_input_tokens", 0) * rates["cache_write"]
        + usage.get("output_tokens", 0) * rates["output"]
    ) / 1_000_000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=float, default=15.0)
    ap.add_argument("--output", type=float, default=75.0)
    ap.add_argument("--cache-read", type=float, default=1.5)
    ap.add_argument("--cache-write", type=float, default=18.75)
    args = ap.parse_args()

    rates = {
        "input": args.input,
        "output": args.output,
        "cache_read": args.cache_read,
        "cache_write": args.cache_write,
    }

    arms = defaultdict(list)

    for record in bench_runs.rows():
        if record.get("trigger") == "ab":
            arms[record.get("label", "?")].append(record)

    if not arms:
        print("no arms recorded in " + ", ".join(bench_runs.diagnostics_files() or ["(no log yet)"]))
        return

    total = 0.0

    for label, runs in sorted(arms.items()):
        print(f"\n{label}  ({len(runs)} replicate{'s' if len(runs) != 1 else ''})")
        print(f"  {'#':>2}  {'chars':>7}  {'out tok':>8}  {'ctx read':>9}  {'secs':>6}  {'$':>6}  outcome")

        for run in runs:
            spend = cost(run.get("usage"), rates)
            total += spend
            usage = run.get("usage") or {}

            print(
                f"  {run.get('replicate', 0):>2}  {run.get('chars', 0):>7,}  "
                f"{usage.get('output_tokens', 0):>8,}  {usage.get('cache_read_input_tokens', 0):>9,}  "
                f"{run.get('elapsedMs', 0) / 1000:>6.1f}  {spend:>6.2f}  {run.get('outcome')}"
            )

        answered = [r for r in runs if r.get("outcome") == "answered"]

        if answered:
            mean = sum(r.get("chars", 0) for r in answered) / len(answered)
            print(f"  mean {mean:,.0f} chars over {len(answered)} answered")

    print(f"\ntotal forks: ${total:,.2f} (arms only; a fixture launch pays its own cache write on top)")


if __name__ == "__main__":
    main()
