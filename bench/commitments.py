"""Find what the assistant promised and never did, and what it later took back.

`appendix.py` is deterministic and can only report what the transcript literally
contains. This is the other half, and it needs a model, because the fact being
looked for is an ABSENCE: a sentence saying "let me check X" is trivial to find,
and the thing worth reporting is that nothing after it ever checked X. No regex
sees that.

It is deliberately one call over a reduced view: the assistant's own words plus a
compact index of what it actually ran. Tool RESULTS are excluded on purpose. They
are most of the bytes, they are truncated in the transcript anyway, and the
question here is not what the code said, it is whether the assistant's own later
turns show it doing the thing it said it would. The tool index is what makes the
absence checkable - an assistant that said "let me verify the lever files" and
never ran a command touching them is visible from the index alone.

Three kinds come back, and they are different failures:

- `unkept` - said it would do, check, fix, verify, re-ask or report; no evidence.
- `corrected` - a claim it later contradicted or withdrew, BOTH versions kept,
  because a handoff carrying only the correction loses why the correction was
  needed, and one carrying only the original ships a known-false fact.
- `unanswered` - a question put to the user that the transcript never answers.

Output is a markdown section, printed to stdout so it can be appended straight
onto a handoff. Cost goes to stderr, so stdout stays clean.

    python3 bench/commitments.py <transcript> --lines 181
"""

import argparse
import json
import os
import re
import subprocess
import sys

from appendix import blocks_of, clip, records_of

TURN_CAP = 6000

ROW = re.compile(r"^\s*(UNKEPT|CORRECTED|UNANSWERED)\s*\|\s*L(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$", re.IGNORECASE)

HEADING = {
    "unkept": "Said it would, no evidence it did",
    "corrected": "Claims corrected or withdrawn",
    "unanswered": "Questions put to the user and never answered",
}

PROMPT = """Below is one side of a conversation: every turn the ASSISTANT spoke or thought, in order, each with the transcript line it came from, followed by an index of every tool call it made. Tool RESULTS are deliberately not shown.

Find three things, and nothing else.

**1. UNKEPT.** Every time the assistant said it would do, check, fix, verify, re-ask, surface, propose or report something, where nothing later in the conversation shows it happening. A commitment stated inside a thinking block counts exactly as much as one said out loud. Use the tool index as your evidence of what actually happened: if the assistant said it would check whether a file exists and no later tool call touches that file, the commitment is unkept.

**2. CORRECTED.** Every claim the assistant made and then contradicted, revised or withdrew later. Report BOTH versions: what it said first, and what it said instead. A correction the assistant recognised but never told the user about is still a correction; say so in the note.

**3. UNANSWERED.** Every question the assistant put to the user that the conversation never answers. A question asked and then answered is not one of these.

**Be exhaustive.** This is the opposite of a conservative pass. The cost of missing a commitment is that the next session never learns work is owed and silently drops it; the cost of a marginal one is a line somebody reads and dismisses. Go turn by turn rather than reporting the few that stand out — a long thinking block usually carries several, and the last turns before the conversation ends carry the most, because they had the least time to be acted on. Read every turn to the end before you answer.

Rules that decide the hard cases:

- The conversation may simply end before the assistant got to something. That still counts as unkept: this exists to hand the next session the list of what is owed, not to blame anybody.
- Do not report a commitment the assistant fulfilled in the same turn it made it.
- Do not report intentions about the far future ("eventually we could"), only things the assistant took on.
- Do not invent line numbers. Every row carries the line the quoted sentence actually appears on.
- Quote the assistant's own words. A paraphrase is worthless here: the next session needs to recognise the promise.
- A problem the assistant identified and said needed a fix, a filter, a cap, a strategy or a design, where no fix, filter, cap, strategy or design appears later, is UNKEPT. Naming a problem and moving on is the most common shape this takes.
- A commitment to check a list of things, where only some of them are checked, is UNKEPT for the remainder. Say which ones.

Output one row per finding, in this exact shape, and nothing else. No preamble, no summary, no closing remarks.

    UNKEPT | L<line> | "<the assistant's sentence, quoted>" | <what is still owed, one line>
    CORRECTED | L<line> | "<the original claim, quoted>" | <what it says instead, and where, one line>
    UNANSWERED | L<line> | "<the question, quoted>" | <why it matters that it is unanswered, one line>

If a kind has no findings, emit no rows for it. If there are no findings at all, output exactly:

    UNKEPT | L0 | "none" | the assistant made no unkept commitments

===== ASSISTANT TURNS =====
{turns}

===== TOOL INDEX (calls only, no results) =====
{index}
"""


def assistant_turns(records):
    """The assistant's own words, thinking included, each tagged with its line."""
    turns = []

    for number, record in records:
        if record.get("type") != "assistant":
            continue

        for block in blocks_of(record):
            kind = block.get("type")

            if kind not in ("text", "thinking"):
                continue

            text = (block.get("text") or block.get("thinking") or "").strip()

            if text:
                turns.append(f"===== line {number} | {kind} =====\n{clip(text, TURN_CAP, number)}")

    return "\n\n".join(turns)


def tool_index(records):
    """What was actually run, one line each. No results: the absence is the point."""
    rows = []

    for number, record in records:
        if record.get("type") != "assistant":
            continue

        for block in blocks_of(record):
            if block.get("type") != "tool_use":
                continue

            args = block.get("input") or {}
            what = args.get("command") or args.get("file_path") or args.get("pattern") or args.get("description") or ""

            rows.append(f"L{number} | {block.get('name')} | {clip(str(what).replace(chr(10), ' ; '), 240)}")

    return "\n".join(rows)


def ask(prompt, model, timeout):
    """One headless call, from a neutral cwd so no project CLAUDE.md is loaded.

    `--output-format json` rather than plain text, because the caller has to be
    able to report what this cost without guessing at it.
    """
    done = subprocess.run(
        ["claude", "-p", "--model", model, "--output-format", "json",
         "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=os.path.expanduser("~"),
    )

    if done.returncode != 0:
        raise RuntimeError(f"commitment pass exited {done.returncode}: {done.stderr[-500:]}")

    payload = json.loads(done.stdout)

    return payload.get("result", ""), payload


def findings_from(reply):
    """Rows the model emitted, in the order it emitted them."""
    found = []

    for line in reply.splitlines():
        match = ROW.match(line)

        if not match:
            continue

        kind, number, quote, note = match.groups()

        found.append({
            "kind": kind.lower(),
            "line": int(number),
            "quote": quote.strip().strip('"').strip(),
            "note": note.strip(),
        })

    return found


def render(findings):
    out = ["## Commitments and open questions", ""]

    out.append("Written by one model pass over the assistant's own turns and an index of what it ran.")
    out.append("Unlike the rest of this appendix it is a judgement, not a reading: an item here is a")
    out.append("claim that something was promised and no evidence of it appears later, which is an")
    out.append("absence and cannot be proved from a transcript that was cut mid-turn.")
    out.append("")

    real = [f for f in findings if f["quote"].lower() != "none"]

    if not real:
        out.append("_The pass found no unkept commitment, correction or unanswered question._")
        out.append("")

        return "\n".join(out)

    for kind in ("unkept", "corrected", "unanswered"):
        rows = [f for f in real if f["kind"] == kind]

        if not rows:
            continue

        out.append(f"### {HEADING[kind]} ({len(rows)})")
        out.append("")

        for row in rows:
            out.append(f"- **L{row['line']}** — \"{row['quote']}\"")
            out.append(f"  - {row['note']}")

        out.append("")

    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("--lines", type=int, default=None, help="Only the first N records, the cut the fixture was built at.")
    ap.add_argument("--model", default="claude-sonnet-5")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--raw", default=None, help="Write the model's unparsed reply here, for auditing the parse.")
    args = ap.parse_args()

    records = records_of(args.transcript, args.lines)

    if not records:
        sys.exit("no records read")

    prompt = PROMPT.format(turns=assistant_turns(records), index=tool_index(records))

    print(f"commitments: {len(prompt):,} chars of prompt over {len(records)} records", file=sys.stderr)

    reply, payload = ask(prompt, args.model, args.timeout)

    if args.raw:
        open(args.raw, "w", encoding="utf-8").write(reply)

    findings = findings_from(reply)

    print(render(findings))

    cost = payload.get("total_cost_usd")
    usage = payload.get("usage") or {}

    print(f"commitments: {len(findings)} rows parsed from {len(reply):,} chars of reply", file=sys.stderr)
    print(f"commitments: cost ${cost:.4f}" if isinstance(cost, (int, float)) else "commitments: cost not reported", file=sys.stderr)
    print(f"commitments: in {usage.get('input_tokens')} out {usage.get('output_tokens')}", file=sys.stderr)


if __name__ == "__main__":
    main()
