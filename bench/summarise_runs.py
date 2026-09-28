"""Tabulate every compaction this plugin has answered, across every session.

Reads the global `index.jsonl` the plugin appends a row to per compaction, plus
the per-compaction `.json` and `.post.json` sitting beside each one, and prints
what a person actually wants to know after a week of it running:

    python3 bench/summarise_runs.py
    python3 bench/summarise_runs.py --days 7
    python3 bench/summarise_runs.py --data-dir /somewhere

How many compactions a day, what they cost per session and per day, which parts
failed and how often, how deep the lineages went, whether the session after a
compaction re-ran work it had already done (for this plugin's handoffs and the
engine's own compactions side by side), and every feedback note anyone left.

Nothing here calls a model and nothing here writes: the rows already carry every
number, which is the point of recording them. Costs are the plugin's own priced
figures (`cost.totalUsd`), never re-derived here, so this file and the plugin
cannot disagree about what a compaction cost. A row the plugin could not price
records `cost: null` and a reason, and is counted as unpriced rather than as
zero; a run with unpriced rows has a cost floor, not a cost.
"""

import argparse
import json
import math
import os
import statistics
import sys
from collections import Counter, defaultdict

DEFAULT_DATA_DIR = os.path.join(os.path.expanduser("~"), ".claude", "compact-handoff")

# The parts of a handoff that are assembled after the model's summary. Each one
# records either its length in chars, the word "empty", or "failed: <why>".
PARTS = ("ledger", "state", "commitments")


def data_dir(override):
    """Where the plugin stores its handoffs, by the same rule the plugin uses."""
    return override or os.environ.get("COMPACT_HANDOFF_DATA_DIR") or DEFAULT_DATA_DIR


def read_rows(root):
    """Every compaction row, oldest first, skipping anything unparseable."""
    path = os.path.join(root, "index.jsonl")

    if not os.path.isfile(path):
        return []

    rows = []

    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()

            if not line:
                continue

            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    rows.sort(key=lambda row: row.get("at") or "")

    return rows


def read_json(path):
    if not path or not os.path.isfile(path):
        return None

    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


def stored_json(row):
    """The full record beside the row: its ledger rows and its feedback."""
    return read_json((row.get("files") or {}).get(".json"))


def post_json(row):
    """What the session did with the handoff, if the monitor got ten turns."""
    path = (row.get("files") or {}).get(".json")

    if not path:
        return None

    return read_json(path[: -len(".json")] + ".post.json")


def day_of(row):
    return (row.get("at") or "?")[:10]


def usd(row):
    """The row's own priced total, or None when the plugin could not price it."""
    cost = row.get("cost")

    return cost.get("totalUsd") if isinstance(cost, dict) else None


def print_per_day(rows):
    print("\nCompactions per day")
    print(f"  {'day':<12}{'runs':>6}{'sessions':>10}{'cost $':>10}{'unpriced':>10}")

    by_day = defaultdict(list)

    for row in rows:
        by_day[day_of(row)].append(row)

    for day, day_rows in sorted(by_day.items()):
        priced = [usd(row) for row in day_rows if usd(row) is not None]
        sessions = len({row.get("sessionId") for row in day_rows})
        unpriced = len(day_rows) - len(priced)

        print(f"  {day:<12}{len(day_rows):>6}{sessions:>10}{sum(priced):>10.3f}{unpriced:>10}")


def print_per_session(rows):
    print("\nPer session")
    print(f"  {'session':<38}{'runs':>6}{'depth':>7}{'cost $':>10}{'fork $':>9}{'commit $':>10}{'unpriced':>10}")

    by_session = defaultdict(list)

    for row in rows:
        by_session[row.get("sessionId") or "unknown"].append(row)

    ordered = sorted(by_session.items(), key=lambda pair: pair[1][-1].get("at") or "")

    for session, session_rows in ordered:
        costs = [row.get("cost") or {} for row in session_rows]
        total = sum(c.get("totalUsd") or 0 for c in costs)
        fork = sum(c.get("forkUsd") or 0 for c in costs)
        commitments = sum(c.get("commitmentsUsd") or 0 for c in costs)
        depth = max((row.get("depth") or 0) for row in session_rows)
        unpriced = sum(1 for row in session_rows if usd(row) is None)

        print(
            f"  {session:<38}{len(session_rows):>6}{depth:>7}"
            f"{total:>10.3f}{fork:>9.3f}{commitments:>10.3f}{unpriced:>10}"
        )


def print_cost_distribution(rows):
    print("\nCost of one compaction")

    priced = sorted(value for value in (usd(row) for row in rows) if value is not None)
    unpriced = [row for row in rows if usd(row) is None]

    if priced:
        print(f"  runs priced      {len(priced)}")
        print(f"  min              ${priced[0]:.4f}")
        print(f"  median           ${statistics.median(priced):.4f}")
        print(f"  mean             ${statistics.fmean(priced):.4f}")
        print(f"  p90              ${priced[math.ceil(len(priced) * 0.9) - 1]:.4f}")
        print(f"  max              ${priced[-1]:.4f}")
        print(f"  total            ${sum(priced):.4f}")

        costs = [row.get("cost") or {} for row in rows if usd(row) is not None]
        forks = [cost.get("forkUsd") or 0 for cost in costs]
        commits = [cost.get("commitmentsUsd") or 0 for cost in costs]

        print(f"  of which fork    ${sum(forks):.4f}")
        print(f"  of which commit  ${sum(commits):.4f}")
    else:
        print("  nothing priced yet")

    if unpriced:
        print("  a total with unpriced rows in it is a floor, not a cost")

        reasons = Counter(row.get("costUnknownReason") or "no reason recorded" for row in unpriced)

        print(f"  unpriced         {len(unpriced)}")

        for reason, count in reasons.most_common():
            print(f"    {count:>4}  {reason}")

    models = Counter((row.get("cost") or {}).get("model") or row.get("model") or "?" for row in rows)
    taken = {(row.get("cost") or {}).get("pricesTaken") for row in rows} - {None}

    print(f"  models           {', '.join(f'{m} x{c}' for m, c in models.most_common())}")

    if taken:
        print(f"  prices taken     {', '.join(sorted(taken))}")


def part_state(parts, name):
    """One of ok / empty / failed / timed out, from what the part recorded."""
    value = parts.get(name)

    if value is None:
        return "missing"

    if isinstance(value, str) and value.startswith("failed:"):
        return "timed out" if "timed out" in value else "failed"

    if value == "empty":
        return "empty"

    return "ok"


def print_part_failures(rows):
    print("\nParts of the handoff")
    print(f"  {'part':<14}{'ok':>6}{'empty':>7}{'failed':>8}{'timed out':>11}{'missing':>9}{'mean ms':>9}")

    for name in PARTS:
        states = Counter()
        times = []

        for row in rows:
            parts = row.get("parts") or {}
            states[part_state(parts, name)] += 1

            elapsed = parts.get(f"{name}Ms")

            if isinstance(elapsed, (int, float)):
                times.append(elapsed)

        mean = f"{statistics.fmean(times):,.0f}" if times else "-"

        print(
            f"  {name:<14}{states['ok']:>6}{states['empty']:>7}{states['failed']:>8}"
            f"{states['timed out']:>11}{states['missing']:>9}{mean:>9}"
        )

    for name in PARTS:
        details = Counter()

        for row in rows:
            value = (row.get("parts") or {}).get(name)

            if isinstance(value, str) and value.startswith("failed:"):
                details[value[: 120]] += 1

        for detail, count in details.most_common():
            print(f"    {name}: {count} x {detail}")

    isolated = Counter(
        (row.get("parts") or {}).get("commitmentsConfigIsolated")
        for row in rows
        if "commitmentsConfigIsolated" in (row.get("parts") or {})
    )

    if isolated:
        ran_isolated = isolated.get(True, 0)
        ran_ambient = isolated.get(False, 0)

        print(f"  commitments ran in an isolated config dir {ran_isolated} times, the ambient one {ran_ambient}")


def print_dispositions(rows):
    print("\nWhat happened to the compaction")

    dispositions = Counter(row.get("disposition") or "?" for row in rows)
    outcomes = Counter(row.get("outcome") or "?" for row in rows)
    triggers = Counter(row.get("trigger") or "?" for row in rows)

    print(f"  disposition  {', '.join(f'{k} x{v}' for k, v in dispositions.most_common())}")
    print(f"  fork outcome {', '.join(f'{k} x{v}' for k, v in outcomes.most_common())}")
    print(f"  trigger      {', '.join(f'{k} x{v}' for k, v in triggers.most_common())}")

    aborted = sum(1 for row in rows if row.get("aborted"))
    trimmed = [row.get("trimmedTurns") or 0 for row in rows]
    over = sum(1 for row in rows if row.get("overCeiling"))
    stored = sum(1 for row in rows if row.get("storeFailed"))

    print(f"  aborted signal seen on {aborted}, over the size ceiling {over}, turns trimmed {sum(trimmed)}")

    if stored:
        print(f"  storage failed on {stored} run(s)")

    elapsed = [row.get("elapsedMs") for row in rows if isinstance(row.get("elapsedMs"), (int, float))]

    if elapsed:
        print(f"  elapsed: median {statistics.median(elapsed) / 1000:.1f}s, max {max(elapsed) / 1000:.1f}s")

    print_fallbacks(rows)


def print_fallbacks(rows):
    """Every compaction the plugin did not replace, and why, counted by reason.

    A fallback is the plugin declining to touch a compaction, which is a
    perfectly good outcome and an invisible one: the session carries on with the
    engine's own summary and nothing says the plugin was there. Counting them by
    reason is the only way a week of them stops being a number and becomes a
    thing to fix. Rows written before `fallbackReason` existed say so.
    """
    fell = [row for row in rows if (row.get("disposition") or "replaced") != "replaced"]

    if not fell:
        print("  no fallbacks: every compaction was replaced")
        return

    reasons = Counter(row.get("fallbackReason") or "(row predates fallbackReason)" for row in fell)

    print(f"\n  fallbacks by reason ({len(fell)} of {len(rows)})")

    for reason, n in reasons.most_common():
        print(f"    x{n:<3} {reason}")

    unpriced = Counter(
        row.get("costUnknownReason") or "(none given)" for row in rows if row.get("cost") is None
    )

    if unpriced:
        print("  rows with no cost, by reason")

        for reason, n in unpriced.most_common():
            print(f"    x{n:<3} {reason}")


def print_depths(rows):
    print("\nHow deep the lineages went")

    depths = Counter(row.get("depth") or 0 for row in rows)

    for depth, count in sorted(depths.items()):
        print(f"  depth {depth:<3} {'#' * min(count, 40)} {count}")

    skipped = Counter()

    for row in rows:
        for reason, count in (row.get("pinnedSkipped") or {}).items():
            skipped[reason] += count

    pinnable = sum(row.get("pinnable") or 0 for row in rows)

    print(f"  pinned turns {pinnable}; skipped {', '.join(f'{k} x{v}' for k, v in skipped.most_common()) or 'none'}")


def observed_posts(rows):
    """Every usable post-compaction record, and how many older ones were set aside.

    A record without `anchored` was written before 0.11.5, when the watch read
    the whole session as though it were the ten turns after the compaction; its
    counts are the session's history, not what followed, so none of it is used.
    """
    observed = [(row, post_json(row)) for row in rows]
    observed = [(row, post) for row, post in observed if post]
    usable = [(row, post) for row, post in observed if post.get("anchored") is True]

    return usable, len(observed) - len(usable)


def print_post(rows):
    print("\nWhat the session did after each compaction (first ten person turns, no model call)")

    observed, set_aside = observed_posts(rows)

    if set_aside:
        print(f"  {set_aside} record(s) from before 0.11.5 set aside: that watch counted the whole session")

    if not observed:
        print("  no post-compaction observations recorded")
        return

    print(f"  {'session':<20}{'kind':<9}{'n':>3}{'turns':>7}{'to tool':>9}{'re-ran':>8}{'re-read':>9}  handoff tools")

    for row, post in observed:
        session = (row.get("sessionId") or "?")[:18]
        tools = ", ".join(post.get("handoffToolsCalled") or []) or "-"
        again = " (compacted again)" if post.get("compactedAgain") else ""
        to_tool = post.get("turnsToFirstToolCall")

        print(
            f"  {session:<20}{post.get('kind', 'handoff'):<9}{post.get('n') or 0:>3}{post.get('turnsObserved', 0):>7}"
            f"{'-' if to_tool is None else to_tool:>9}"
            f"{len(post.get('reRunCommands') or []):>8}{len(post.get('reReadFiles') or []):>9}  {tools}{again}"
        )

    commands = Counter()

    for _, post in observed:
        for command in post.get("reRunCommands") or []:
            commands[command[:100]] += 1

    for command, count in commands.most_common(10):
        print(f"    {count} x {command}")


def print_baseline(rows):
    """This plugin's handoffs against the engine's own compactions, side by side.

    The stock arm is every main-session compaction the engine did itself: a
    rehearsal, a fallback, an aborted dispatch. Its watch is the same as a
    handoff's, so the two columns are the same measurement. What neither can
    say is which conversations landed in which arm: fallbacks are not a random
    sample, so read a gap as a lead, not a result.
    """
    print("\nHandoff against the engine's own compaction (same watch, both arms)")

    observed, _ = observed_posts(rows)
    arms = defaultdict(list)

    for _, post in observed:
        arms[post.get("kind", "handoff")].append(post)

    if not arms:
        print("  nothing to compare yet")
        return

    def median_of(posts, key):
        values = [post[key] for post in posts if isinstance(post.get(key), (int, float))]

        return f"{statistics.median(values):.1f}" if values else "-"

    def mean_len(posts, key):
        return f"{statistics.fmean(len(post.get(key) or []) for post in posts):.2f}"

    def rate(posts, test):
        return f"{100 * sum(1 for post in posts if test(post)) / len(posts):.0f}%"

    print(f"  {'arm':<9}{'watched':>8}{'median turns to tool':>22}{'re-ran':>8}{'re-read':>9}{'used handoff tool':>19}{'compacted again':>17}")

    for kind in ("handoff", "stock"):
        posts = arms.get(kind, [])

        if not posts:
            print(f"  {kind:<9}{0:>8}  no observations yet")
            continue

        print(
            f"  {kind:<9}{len(posts):>8}{median_of(posts, 'turnsToFirstToolCall'):>22}"
            f"{mean_len(posts, 'reRunCommands'):>8}{mean_len(posts, 'reReadFiles'):>9}"
            f"{rate(posts, lambda post: post.get('handoffToolsCalled')):>19}"
            f"{rate(posts, lambda post: post.get('compactedAgain')):>17}"
        )

    print("  re-ran and re-read are means per compaction; turns count what the person typed")


def print_feedback(rows):
    print("\nFeedback left on a handoff")

    found = 0

    for row in rows:
        stored = stored_json(row)

        for note in (stored or {}).get("feedback") or []:
            found += 1

            print(f"  {note.get('at', '?')}  session {row.get('sessionId')} depth {row.get('depth')}")
            print(f"    {note.get('note', '')}")

    if not found:
        print("  none")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-dir", default=None, help="Overrides COMPACT_HANDOFF_DATA_DIR.")
    ap.add_argument("--days", type=int, default=0, help="Only the N most recent days that have rows.")
    ap.add_argument("--session", default=None, help="Only this session id.")
    args = ap.parse_args()

    root = data_dir(args.data_dir)
    rows = read_rows(root)

    if not rows:
        print(f"no compactions recorded under {root}")
        return 0

    if args.session:
        rows = [row for row in rows if row.get("sessionId") == args.session]

    if args.days:
        keep = sorted({day_of(row) for row in rows})[-args.days :]
        rows = [row for row in rows if day_of(row) in keep]

    if not rows:
        print("no rows match that filter")
        return 0

    versions = Counter(f"{row.get('plugin') or '?'} on engine {row.get('engine') or 'unknown'}" for row in rows)

    print(f"{len(rows)} compaction(s) under {root}")
    print(f"  {', '.join(f'{k} x{v}' for k, v in versions.most_common())}")

    print_per_day(rows)
    print_per_session(rows)
    print_cost_distribution(rows)
    print_part_failures(rows)
    print_dispositions(rows)
    print_depths(rows)
    print_post(rows)
    print_baseline(rows)
    print_feedback(rows)

    return 0


if __name__ == "__main__":
    sys.exit(main())
