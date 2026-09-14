"""Render a fixture transcript to something a model can read end to end.

The checklist a handoff is graded against has to come from the source, and the
source is a million bytes of JSONL where most of the weight is tool results
nobody needs verbatim. This flattens it: every user turn and every word of
assistant prose in full, because that is where intent and decisions live, and
tool calls kept as a name plus a truncated argument and a truncated result,
because what matters about a command is that it ran and what it said, not its
thousand lines of output.

Each entry carries the 1-based line number of its record in the source file, so
a checklist atom can cite where it came from and be checked.

    python3 bench/source.py <transcript.jsonl> --lines 181

`--lines` matters more than it looks. A fixture keeps being appended to by the
bench runs themselves, so the file on disk today is not the file the arms were
asked about. Cut it back to the line count the fixture was built at.
"""

import argparse
import json

TOOL_ARG_CAP = 900
TOOL_RESULT_CAP = 4000
THINKING_CAP = 4000


def clip(text, cap):
    text = text.strip()

    if len(text) <= cap:
        return text

    return text[:cap] + f"\n  [... {len(text) - cap:,} more chars]"


def blocks_of(record):
    """The content blocks of a record, whatever shape it arrived in."""
    content = (record.get("message") or {}).get("content")

    if isinstance(content, str):
        return [{"type": "text", "text": content}]

    if isinstance(content, list):
        return content

    return []


def render_block(block):
    kind = block.get("type")

    if kind == "text":
        return clip(block.get("text", ""), 100_000)

    if kind == "thinking":
        return f"[thinking] {clip(block.get('thinking', ''), THINKING_CAP)}"

    if kind == "tool_use":
        args = json.dumps(block.get("input", {}), ensure_ascii=False)

        return f"[tool_use {block.get('name')}] {clip(args, TOOL_ARG_CAP)}"

    if kind == "tool_result":
        body = block.get("content")

        if isinstance(body, list):
            body = "\n".join(p.get("text", "") for p in body if isinstance(p, dict))

        return f"[tool_result] {clip(str(body), TOOL_RESULT_CAP)}"

    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("--lines", type=int, default=None, help="Only the first N records, the cut the fixture was built at.")
    args = ap.parse_args()

    out = []

    with open(args.transcript, encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if args.lines is not None and number > args.lines:
                break

            line = line.strip()

            if not line:
                continue

            record = json.loads(line)
            role = record.get("type")

            if role not in ("user", "assistant"):
                continue

            rendered = [r for r in (render_block(b) for b in blocks_of(record)) if r]

            if not rendered:
                continue

            out.append(f"===== line {number} | {role} =====")
            out.extend(rendered)

    print("\n".join(out))


if __name__ == "__main__":
    main()
