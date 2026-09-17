"""Render one `compare274.py run` row as a single self-contained HTML page.

No stylesheet, no script tag from anywhere else: the page is one file that can
be dropped behind a tunnel or opened off disk, because the point is for a person
to read four compactions of the same conversation next to each other and decide.
"""

import html
import json
import os
import re

PANES = (
    (
        "baseline",
        "1. What Claude Code has always done",
        "When a chat gets too long, Claude Code rewrites the whole conversation into a summary and "
        "throws the original away. This is that. It did NOT change in 2.1.274 - the wording is "
        "identical to 2.1.270, character for character.",
    ),
    (
        "recent274",
        "2. NEW: summarise only the last few messages",
        "2.1.274 added this. Instead of rewriting everything, Claude Code can now keep the older "
        "messages as they are and summarise only the recent ones. So this summary is meant to cover "
        "just the tail end, not the whole chat.",
    ),
    (
        "handoff274",
        "3. NEW: a catch-up note for carrying on",
        "2.1.274 also added this. It writes a 'here is where we got to' note that goes at the top of "
        "a continuing session, with new messages arriving underneath it. It ends with what was "
        "finished and what to do next.",
    ),
)

CSS = """
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 2.5rem 6rem;
  background: #0f1115; color: #d8dce3;
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
h1 { font-size: 1.6rem; margin: 0 0 .4rem; color: #fff; letter-spacing: -.01em; }
h2 { font-size: 1.15rem; margin: 2.6rem 0 .8rem; color: #fff; }
.sub { color: #8b93a1; margin: 0 0 2rem; }
a { color: #7aa2f7; }
table { border-collapse: collapse; width: 100%; margin: 0 0 1rem; font-size: 14px; }
th, td { text-align: left; padding: .5rem .7rem; border-bottom: 1px solid #222733; }
th { color: #8b93a1; font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.plugin td { background: #141a24; }
.note {
  border-left: 3px solid #b8860b; background: #191710; padding: .85rem 1.1rem;
  margin: 1.2rem 0; color: #cfc8b4;
}
.note strong { color: #e8d9a8; }
.grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; align-items: start; }
@media (max-width: 1500px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 800px)  { .grid { grid-template-columns: 1fr; } }
.pane { background: #151922; border: 1px solid #222733; border-radius: 8px; overflow: hidden; }
.pane.mine { border-color: #3d5a8a; }
.pane header { padding: .8rem 1rem; border-bottom: 1px solid #222733; background: #1a1f2b; }
.pane.mine header { background: #1b2233; }
.pane h3 { margin: 0 0 .25rem; font-size: .95rem; color: #fff; }
.pane .why { margin: 0; font-size: 12.5px; color: #8b93a1; line-height: 1.45; }
.pane .meta { margin: .5rem 0 0; font-size: 12px; color: #6f7787; font-variant-numeric: tabular-nums; }
.pane pre {
  margin: 0; padding: 1rem; max-height: 62vh; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
  font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #c3c9d4;
}
.empty { padding: 1rem; color: #7d5a5a; }
details { margin: .6rem 0; }
summary { cursor: pointer; color: #7aa2f7; }
details pre {
  background: #151922; border: 1px solid #222733; border-radius: 6px;
  padding: 1rem; margin: .6rem 0 0; max-height: 50vh; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
  font: 12.5px/1.55 ui-monospace, Menlo, Consolas, monospace; color: #c3c9d4;
}

.sects { margin: 0; padding: .6rem 1rem 1rem; list-style: none; }
.sects li { margin: 0 0 .75rem; padding: 0; }
.sects b { display: block; color: #fff; font-size: 13.5px; }
.sects span { display: block; color: #98a0ae; font-size: 12.5px; line-height: 1.45; margin-top: .15rem; }
footer { margin-top: 3rem; padding-top: 1.2rem; border-top: 1px solid #222733; color: #6f7787; font-size: 13px; }
"""


SECTION_RE = re.compile(r"^\s*(?:(#{2,4})\s+(\S.*)|(\d{1,2})\.\s+([A-Z][^:]{3,90}):)\s*$")


def sections(text, limit=150):
    """Every heading in one arm's output, with the first line of prose under it.

    Both arms number their sections and both also use markdown headings, so one
    pattern reads either. The first non-blank line below a heading is the whole
    point: a heading alone does not show which way a section faces.
    """
    lines = (text or "").splitlines()
    found = []

    for index, line in enumerate(lines):
        match = SECTION_RE.match(line)

        if not match:
            continue

        heading = (match.group(2) or f"{match.group(3)}. {match.group(4)}").strip()
        first = next((l.strip() for l in lines[index + 1 : index + 8] if l.strip()), "")
        found.append((heading, first[:limit] + ("..." if len(first) > limit else "")))

    return found


def section_list(title, why, text, mine=False):
    rows = "\n".join(
        f"<li><b>{esc(head)}</b><span>{esc(first)}</span></li>" for head, first in sections(text)
    ) or "<li><b>nothing to show</b></li>"

    return f"""<section class="pane{' mine' if mine else ''}">
  <header>
    <h3>{esc(title)}</h3>
    <p class="why">{esc(why)}</p>
  </header>
  <ul class="sects">{rows}</ul>
</section>"""


def esc(text):
    return html.escape(text if isinstance(text, str) else "")


def usd(cost):
    if not cost or cost.get("totalUsd") is None:
        return "unpriced"

    return f"${cost['totalUsd']:.4f}"


def secs(ms):
    if not isinstance(ms, (int, float)):
        return "-"

    return f"{ms / 1000:.0f}s"


def num(value):
    return f"{value:,}" if isinstance(value, int) else "-"


def pane(title, why, meta, text, mine=False):
    body = f"<pre>{esc(text)}</pre>" if text else '<p class="empty">This arm returned nothing.</p>'

    return f"""<section class="pane{' mine' if mine else ''}">
  <header>
    <h3>{esc(title)}</h3>
    <p class="why">{esc(why)}</p>
    <p class="meta">{esc(meta)}</p>
  </header>
  {body}
</section>"""


def summary_table(row):
    lines = [
        "<table><thead><tr><th>Which one</th><th>What it does</th><th class='num'>Prompt</th>"
        "<th class='num'>Output</th><th class='num'>Cost</th><th class='num'>Elapsed</th></tr></thead><tbody>"
    ]

    for number, (key, title, _) in enumerate(PANES, start=1):
        arm = (row.get("arms") or {}).get(key) or {}
        lines.append(
            f"<tr><td>{number}</td><td>{esc(title.split('. ', 1)[-1])}</td>"
            f"<td class='num'>{num((row.get('promptChars') or {}).get(key))}</td>"
            f"<td class='num'>{num(arm.get('chars'))}</td>"
            f"<td class='num'>{esc(usd(arm.get('cost')))}</td>"
            f"<td class='num'>{esc(secs(arm.get('elapsedMs')))}</td></tr>"
        )

    plug = row.get("plugin") or {}
    lines.append(
        "<tr class='plugin'><td>4</td><td>Our plugin, instead of any of the above</td>"
        "<td class='num'>-</td>"
        f"<td class='num'>{num(plug.get('handoffChars'))}</td>"
        f"<td class='num'>{esc(usd(plug.get('cost')))}</td>"
        f"<td class='num'>{esc(secs(plug.get('elapsedMs')))}</td></tr>"
    )
    lines.append("</tbody></table>")

    return "\n".join(lines)


def render(row, out):
    plug = row.get("plugin") or {}
    arms = row.get("arms") or {}

    panes = [
        pane(
            title,
            why,
            f"{num((arms.get(key) or {}).get('chars'))} chars · {usd((arms.get(key) or {}).get('cost'))}",
            (arms.get(key) or {}).get("text"),
        )
        for key, title, why in PANES
    ]
    panes.append(
        pane(
            "compact-handoff",
            "4. Our plugin, which replaces all of the above. It writes a summary too, then adds three "
            "sections it looks up from disk instead of trying to remember, and hands the whole thing "
            "back as the new conversation.",
            f"{num(plug.get('handoffChars'))} chars "
            f"(summary {num(plug.get('summaryChars'))}) · {usd(plug.get('cost'))} · "
            f"{plug.get('disposition') or '-'}",
            plug.get("handoffText"),
            mine=True,
        )
    )

    section_panes = [
        section_list(
            "Claude Code's new catch-up note",
            "What the built-in version wrote, heading by heading.",
            (arms.get("handoff274") or {}).get("text"),
        ),
        section_list(
            "Our plugin",
            "What ours wrote, heading by heading. The last four sections have no equivalent on the left.",
            plug.get("handoffText"),
            mine=True,
        ),
    ]

    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compaction, four ways — Claude Code {esc(row.get('version') or '')}</title>
<style>{CSS}</style>
</head>
<body>

<h1>Four ways to shorten a long chat</h1>
<p class="sub">
  One conversation, one session, four compactions of it. Claude Code {esc(row.get('version') or '?')},
  model {esc(row.get('model') or '?')}, shortened from a real chat of about {row.get('target', 0):,} tokens
  ({num(row.get('fixtureBytes'))} bytes). Run {esc(row.get('at') or '')}.
</p>

<h2>What this page is</h2>
<p>
  When a chat gets too long, it has to be shortened. Claude Code calls this compaction. Below is the
  same conversation shortened four different ways, so you can read them next to each other and decide
  which you like.
</p>
<h2>What changed in version 2.1.274</h2>
<p>
  The old way of shortening a chat <strong>did not change at all</strong>. We compared the exact wording
  Claude Code uses, and it is identical to the previous version, character for character. So there is no
  "new version" of the old behaviour to go back to.
</p>
<p>
  What the new version added is <strong>two extra ways</strong> alongside it. One summarises only the
  last few messages, because it can now keep the older ones as they are. The other writes a catch-up
  note that sits at the top of a continuing session. Shortening a chat is no longer one single move that
  wipes everything.
</p>

<div class="note">
  <strong>One thing to know about column 2 before you judge it.</strong>
  We could not feed it only the last few messages - the tool we use to run these tests always hands over
  the whole conversation. So column 2 read everything, the same as the others, while being told to cover
  only the recent part. It shows how those instructions behave. It is not an exact copy of what Claude
  Code itself would do.
</div>

<div class="note">
  <strong>None of this reaches our plugin.</strong>
  When our plugin takes over the shortening, Claude Code hands it the entire conversation and nothing
  else. The three ways above all live inside the part our plugin replaces, so the new version changes
  nothing about how our plugin works.
</div>

<h2>Size, cost and time</h2>
{summary_table(row)}

<h2>What we learned</h2>
<p>
  This is one test on one conversation. Summaries vary a lot run to run, so do not read much into the
  exact sizes - run it again and every number moves. The three points below would not move.
</p>
<ol>
  <li>
    <strong>Column 2 barely summarised anything.</strong> It was told the older messages are being kept,
    so it wrote up only the last two messages and skipped everything before them. That is it doing
    exactly what it was asked. It also shows this way of shortening does not work on its own - it is
    only half the job, and the other half is the older messages Claude Code keeps untouched.
  </li>
  <li>
    <strong>Column 3 is the interesting one.</strong> It reads like a handover note rather than a
    record of what happened: it ends with what was finished and what someone picking this up needs to
    know. That is the instinct our plugin was built on, reached separately - though ours goes further,
    as the section-by-section comparison below shows.
  </li>
  <li>
    <strong>There is no reason to drop our plugin and go back to the built-in behaviour.</strong> The
    old way did not change, so there is no improvement to switch back to, and neither new way does what
    our plugin does. Our plugin still adds three sections it looks up from disk rather than trying to
    remember, which none of the built-in options can do.
  </li>
</ol>

<h2>Section by section: the new catch-up note, and ours</h2>
<p>
  Every heading each one wrote, with the first line underneath it. Sections 1 to 7 are near-identical.
  What differs is the end.
</p>
<p>
  Claude Code's new note renames its last two sections to <em>Work Completed</em> and
  <em>Context for Continuing Work</em>: it stops describing what happened and starts telling whoever
  picks this up what they need. Ours keeps the older <em>Current Work</em> and <em>Optional Next Step</em>
  headings, then goes further - it appends a work ledger and three sections looked up from git and the
  transcript as the summary is written, rather than remembered. Same instinct, reached separately,
  carried a different distance.
</p>
<div class="grid two">
{chr(10).join(section_panes)}
</div>

<h2>The four shortened versions, side by side</h2>
<div class="grid">
{chr(10).join(panes)}
</div>

<h2>Our plugin's summary on its own</h2>
<p>
  Column 4 above is the finished thing: a summary plus three looked-up sections. Below is just the
  summary part, which is the fair like-for-like against the three built-in versions.
</p>
<details open>
  <summary>Our plugin's summary ({num(plug.get('summaryChars'))} chars)</summary>
  <pre>{esc(plug.get('summaryText') or 'nothing recorded')}</pre>
</details>

<h2>Raw data</h2>
<details>
  <summary>The recorded results for this run, with the long texts removed</summary>
  <pre>{esc(json.dumps(stripped(row), indent=2))}</pre>
</details>

<footer>
  Generated by <code>bench/page274.py</code> from <code>bench/compare274.py run</code>.
  Prompts extracted from the 2.1.274 binary and committed at
  <code>bench/prompts/recent274.txt</code> and <code>bench/prompts/handoff274.txt</code>.
</footer>

</body>
</html>
"""

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    with open(out, "w", encoding="utf-8") as handle:
        handle.write(doc)

    return out


def stripped(row):
    """The row without the four long texts, which the page already shows."""
    thin = json.loads(json.dumps(row))

    for arm in (thin.get("arms") or {}).values():
        if isinstance(arm, dict):
            arm.pop("text", None)

    if isinstance(thin.get("plugin"), dict):
        thin["plugin"].pop("handoffText", None)
        thin["plugin"].pop("summaryText", None)

    return thin
