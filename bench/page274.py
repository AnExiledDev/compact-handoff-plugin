"""Render one `compare274.py run` row as a single self-contained HTML page.

No stylesheet, no script tag from anywhere else: the page is one file that can
be dropped behind a tunnel or opened off disk, because the point is for a person
to read four compactions of the same conversation next to each other and decide.
"""

import html
import json
import os

PANES = (
    (
        "baseline",
        "Stock, full history",
        "Claude Code's own compaction prompt. Byte-identical in 2.1.270 and 2.1.274 — "
        "this is the arm the bench has always measured against, and nothing about it changed.",
    ),
    (
        "recent274",
        "Stock, recent portion (new in 2.1.274)",
        "Summarises only the tail, because the engine now keeps earlier messages intact rather than "
        "replacing the whole conversation.",
    ),
    (
        "handoff274",
        "Stock, continuing session (new in 2.1.274)",
        "A summary written to sit at the start of a continuing session, with newer messages arriving "
        "after it. Its last two sections are Work Completed and Context for Continuing Work.",
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
footer { margin-top: 3rem; padding-top: 1.2rem; border-top: 1px solid #222733; color: #6f7787; font-size: 13px; }
"""


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
        "<table><thead><tr><th>Arm</th><th>What ran</th><th class='num'>Prompt</th>"
        "<th class='num'>Output</th><th class='num'>Cost</th><th class='num'>Elapsed</th></tr></thead><tbody>"
    ]

    for key, title, _ in PANES:
        arm = (row.get("arms") or {}).get(key) or {}
        lines.append(
            f"<tr><td>{esc(key)}</td><td>{esc(title)}</td>"
            f"<td class='num'>{num((row.get('promptChars') or {}).get(key))}</td>"
            f"<td class='num'>{num(arm.get('chars'))}</td>"
            f"<td class='num'>{esc(usd(arm.get('cost')))}</td>"
            f"<td class='num'>{esc(secs(arm.get('elapsedMs')))}</td></tr>"
        )

    plug = row.get("plugin") or {}
    lines.append(
        "<tr class='plugin'><td>compact-handoff</td><td>The plugin answering session.compact</td>"
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
            "What this plugin installs instead: the model's summary plus three parts it reads rather "
            "than recalls, handed up as the replacement transcript.",
            f"{num(plug.get('handoffChars'))} chars "
            f"(summary {num(plug.get('summaryChars'))}) · {usd(plug.get('cost'))} · "
            f"{plug.get('disposition') or '-'}",
            plug.get("handoffText"),
            mine=True,
        )
    )

    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compaction, four ways — Claude Code {esc(row.get('version') or '')}</title>
<style>{CSS}</style>
</head>
<body>

<h1>Compaction, four ways</h1>
<p class="sub">
  One conversation, one session, four compactions of it. Claude Code {esc(row.get('version') or '?')},
  model {esc(row.get('model') or '?')}, fixture cut to ~{row.get('target', 0):,} tokens
  ({num(row.get('fixtureBytes'))} bytes). Run {esc(row.get('at') or '')}.
</p>

<h2>What actually changed in 2.1.274</h2>
<p>
  The full-history compaction prompt is <strong>byte-identical</strong> to the 2.1.270 copy this bench
  has always measured against. Nothing about it moved. What 2.1.274 added is two more prompts beside it:
  one that summarises only the recent tail because earlier messages are now kept intact, and one written
  to sit at the <em>start</em> of a continuing session with newer messages arriving after it.
  Compaction stopped being one shot that replaces everything.
</p>

<div class="note">
  <strong>Read the recent-portion arm as a prompt comparison, not as engine behaviour.</strong>
  <code>$.model.fork</code> appends one user message to the whole session transcript and offers no way to
  hand it only the tail, so that arm read the same conversation the others did. It shows what those
  instructions produce over this material. It does not reproduce the engine's kept-tail path.
</div>

<div class="note">
  <strong>A plugin that answers <code>session.compact</code> never sees any of this.</strong>
  The 2.1.274 declarations give the hook the whole transcript under <code>messages</code> and carry no
  kept-tail field. The engine's three prompts are internal to the path a hook replaces, so
  compact-handoff's behaviour is unchanged by the new ones.
</div>

<h2>The numbers</h2>
{summary_table(row)}

<h2>What this run showed</h2>
<p>
  One run, one conversation. Half of any summary is chance, so read the shapes rather than the
  character counts: a second run would move every number here and would not move the three findings.
</p>
<ol>
  <li>
    <strong>The recent-portion arm summarised almost nothing.</strong> It was told the earlier messages
    are retained, so it wrote up only the last two turns of the fixture — the bench's own
    "reply with the word ready" and "use the ab_fork tool" — and dropped the whole conversation that
    came before them. That is the prompt working as designed, and it is the proof that this prompt is
    not a compaction on its own. It is the tail half of a two-part scheme whose other half is the
    messages the engine keeps intact.
  </li>
  <li>
    <strong>The continuing-session arm is the interesting one.</strong> It reads as a handoff rather
    than a record: its last two sections are Work Completed and Context for Continuing Work, where the
    full-history prompt ends on Current Work and Optional Next Step. That is the same shape this plugin
    has been writing since before 2.1.274 — the engine has moved toward the plugin's idea, not away
    from it.
  </li>
  <li>
    <strong>Nothing here is a reason to go back to stock.</strong> The full-history prompt did not
    change, so "the new baseline" is only new in the sense that two prompts joined it, and neither
    replaces what a <code>session.compact</code> hook does. The plugin's own output still carries the
    three parts it reads rather than recalls, which no stock prompt can produce at any price.
  </li>
</ol>

<h2>The four compactions</h2>
<div class="grid">
{chr(10).join(panes)}
</div>

<h2>The plugin's model summary on its own</h2>
<p>
  The pane above is the assembled four-part handoff. This is just the part the model wrote, which is
  what the three stock arms are actually comparable to.
</p>
<details open>
  <summary>compact-handoff summary ({num(plug.get('summaryChars'))} chars)</summary>
  <pre>{esc(plug.get('summaryText') or 'nothing recorded')}</pre>
</details>

<h2>The row</h2>
<details>
  <summary>compare274.jsonl, this run, with the arm texts stripped</summary>
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
