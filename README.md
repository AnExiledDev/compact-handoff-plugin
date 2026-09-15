> **AI-written.** No human has read this. Every requirement below is an agent's inference.
> `session: e0b89429 | 2026-09-14`

# compact-handoff

When Claude Code runs out of context it writes a summary of the conversation
and throws the conversation away. This plugin writes the summary instead, and
staples three things to it that no summary can be trusted to remember: what was
actually run, what the repository actually looks like right now, and what was
promised and never finished.

It also keeps the conversation it replaced, so anything the handoff left out can
still be searched for afterwards.

## What a compaction hands up

Six parts. Only the first is a model summarising a conversation.

1. **The summary**, written by a fork of the session itself. The fork is asked
   with Claude Code's own summariser instruction plus a Work ledger section
   whose subsections must appear even when empty. The empty-subsection rule is
   the whole trick: a model with nothing to write under *Rejected by the user*
   has to decide that heading is empty rather than never think about rejections
   at all. Rejected-approach carry went from 11.1% to 61.1% on that alone.
2. **The tool ledger**, read off the messages, not recalled: files written,
   every shell command in order, and the ones whose output reads as a failure.
   **Nothing here is an exit code**, because the transcript does not store one,
   so "no error flag" does not mean "succeeded". Only the rows since the last
   compaction. Until 0.2.0 every earlier compaction's rows were merged in too,
   and by the tenth compaction of one session that was 65k of an 82k-character
   handoff, a quarter of a 200k window spent re-reading history every turn.
3. **Session state**, read live from `git` and `gh` as the handoff is written:
   branch, working tree, uncommitted files, open PRs, the last five commits, the
   session's model, and any agents still running. It describes the moment of
   compaction and nothing else. A row that cannot be read is left out rather
   than guessed at.
4. **Commitments and open questions**, from one `claude -p` pass over the
   assistant's own turns. The fact it looks for is an absence: "let me check X"
   is easy to find, but what matters is that nothing after it ever checked X,
   and no pattern sees that. Two rounds of prompt wording could not move that
   class of fact; one model call moved it from 35.7% to 73.8%.
5. **Every user turn, verbatim**, pinned by the engine's own `handle` rather
   than re-typed, so the words survive word for word instead of being rebuilt
   from a paraphrase.
6. **The files the next window should have open**, chosen by the summariser
   (0.3.0). Claude Code's own compaction re-attaches up to five of the most
   recently read files, and that path never runs when a hook answers the
   event, so until 0.3.0 a handoff came back with none. Now the fork ends its
   summary with a `<restore-files>` block naming up to five files, each by
   absolute path with `all` or a line range and a reason. The code only
   refuses: a path the session never read or wrote, a `CLAUDE.md` or
   `AGENTS.md` (the engine re-emits those itself), a duplicate, anything past
   the cap. When nothing usable was named, the most recently touched files go
   instead and the row says `source: "recency"`. Each file is re-read through
   the real Read tool, so a file edited mid-session comes back current; a read
   that is denied, errors or takes over 20 seconds falls back to the text of
   the transcript's last Read of it (`source: "stored"`). Each one is handed up
   as a real `Read` tool_use and its tool_result, not a narration of one, so
   the next window treats it exactly as a file it read. Per file 20,000
   characters, 100,000 in all, both clipped rather than dropped past the file
   cap and dropped past the total, and never past the size guard's ceiling.
   Every cap is a setting below, and `record.restore` carries what would be
   needed to move one: source, requested, restored, every rejection and why,
   and per file the lines, chars, approximate tokens, clipped chars and
   milliseconds. `handoff_status` sums them under `restores`.

Parts 2 to 4 are gathered concurrently and every one of them may fail. A part
that throws, times out or comes back empty is left out and named in the row; the
summary alone is still the arm that scored 67.3%.

Measured paired against byte-identical model text, 82 atoms from one real
session, three grading passes each, on `claude-sonnet-5`:

| arm | appended | recall | net | spread |
| --- | --- | --- | --- | --- |
| armA | nothing | 67.3% | 66.1% | 3.0% |
| armB | tool ledger | 68.7% | 65.0% | 4.9% |
| armD | ledger + commitments | **71.1%** | **67.5%** | **1.2%** |

**It rehearses by default.** Without `COMPACT_HANDOFF_LIVE` it does the whole
thing, writes down what it *would* have handed up, and then calls `next(e)`
anyway, so the engine compacts exactly as it does today. Every failure path does
the same. The worst case of installing it is the behaviour you already have,
plus a log.

## Where the data lives

`~/.claude/compact-handoff/`, outside any repository, because the plugin's own
root is a worktree somebody may delete. `COMPACT_HANDOFF_DATA_DIR` moves it.

```
~/.claude/compact-handoff/
  index.jsonl                        every compaction on this box, one line each
  sessions/<sessionId>/
    NNN-<iso>.md                     the handoff that was handed up
    NNN-<iso>.summary.md             just the model's part of it
    NNN-<iso>.transcript.md          the conversation as it stood before
    NNN-<iso>.json                   the row, the ledger, feedback, lineage
    NNN-<iso>.post.json              what the session did in its next ten turns
    runs.jsonl                       this session's compactions, append-only
    lookups.jsonl                    every history read this session made, with its size
    diagnostics.jsonl                probes, forced compactions, A/B arms
  rehearsals/<sessionId>/            the same, for runs that did not go live
```

Nothing is ever rewritten. Every file is written once and every log is appended
to, because two sessions compacting in the same minute must not be able to lose
each other's rows. `index.jsonl` is appended through `sh -c 'cat >> ...'`,
because the host filesystem API has no append.

Each handoff's first line is a machine-readable lineage marker:

```
<!-- compact-handoff: session=<id> n=003 prev=002 -->
```

A later compaction reads it, records `depth`, and prepends an "Earlier
compactions" note naming every earlier pass and how to read it back. **Only the
newest handoff travels in the window.** Everything an earlier compaction wrote
stays on disk behind `handoff_lookup` and `handoff_search`, so history costs
context only when a session asks for it, and every such read is logged:

```
~/.claude/compact-handoff/lookups.jsonl            every history read on this box
~/.claude/compact-handoff/sessions/<id>/lookups.jsonl   this session's reads
```

One row per `handoff_lookup`, `handoff_search` or `handoff_list` call: `at`,
`sessionId`, `tool`, `args`, `chars`, `lines` and `approxTokens`. The token
figure is characters over four, the same estimate the size guard uses, not a
tokenizer; the name says so. `handoff_status` sums them under `lookups`.

### Reading one row

A row says what the compaction did and, when it did not do it, why. The fields
that matter for that second case:

| field | when | what it says |
|---|---|---|
| `disposition` | always | `replaced`, `rehearsed`, `fellBack`, `passedThrough`, `overBudget`, `abortedFallback` |
| `fallbackReason` | every disposition but `replaced` | one line naming why, e.g. `noHandoff: no handoff has been written yet (fork cold: the fork found no warm main-thread transcript)` |
| `cost` | always | `{forkUsd, commitmentsUsd, commitmentsBasis, totalUsd, forkUsage, model, priced, pricesTaken}`, or `null`. `commitmentsBasis` is `estimate: chars/4, no cache` since 0.4.0, `none` when no commitments pass ran, `measured` on rows from 0.3.0 and earlier |
| `maxHandoff` | every `replaced` and `rehearsed` row | the handoff ceiling the size guard used and how it was arrived at: `{window, fraction, capTokens, chars, decider}`, where `decider` is `fraction`, `cap`, `default: window unknown` or `override`; an override past the safe cap adds `overSafeCapChars` and `overSafeCapTokens` saying by how much |
| `forkContext` | every row that forked | what the session looked like the instant before `$.model.fork`: `{context, model, messages, msSinceLastFork, subagentRanThisTurn}`, where `context` is the whole `$.session.usage().context` object (`tokens`, `window`, `percent`) and `msSinceLastFork` is `null` on a session's first fork |
| `parts` | every `replaced` and `rehearsed` row | per-part sizes and timings; for the commitments pass, `commitmentsVia`, `commitmentsModel`, `commitmentsPromptChars`, `commitmentsReplyChars`, `commitmentsTokensEstimated`, `commitmentsCostUsd`, `commitmentsCostBasis`, and since 0.4.0 `commitmentsRows` (how many rows came back) with `commitmentsHitCap` and `commitmentsHitCapReason` (`length` or `truncated row`) saying whether the reply stopped at the 8192-token output cap |
| `costUnknownReason` | when `cost` is `null` | why it could not be priced. A run is never priced at 0 because its usage was missing |
| `costNote` | when nothing was spent | `no model call was made`. A pass-through and a refusal over budget cost a real zero, which is not the same as unknown |
| `overCeiling` | always | the size guard could not fit the replacement, because the handoff itself is larger than the ceiling and is never trimmed |
| `restore` | every `replaced` and `rehearsed` row | `{source, requested, restored, rejected, files, chars, approxTokens, caps, ms}`; `source` is `model`, `recency` or `none`, and each file's `source` is `fresh`, `stored`, `failed` or `dropped` |

`bench/summarise_runs.py` counts fallbacks by reason and unpriced rows by
reason, so a week of silent declines is a list rather than a number.

## The tools

Six, served as loopback MCP:

| tool | what it does |
| --- | --- |
| `handoff_status` | What would happen if this conversation compacted right now: live or rehearsing, where the data is, how many compactions this session has had, what the last one did, what this session has spent, how much history it has read back (`lookups`), and what the restores have put back (`restores`). |
| `handoff_list` | Every compaction this session has been through, oldest first, with cost, size and files. |
| `handoff_lookup` | Read a stored compaction back. `section` takes `summary`, `ledger`, `state`, `commitments` or `transcript`; long sections page. |
| `handoff_search` | Grep every stored handoff and pre-compaction transcript of this session. This is how to find what a handoff did not carry up. |
| `handoff_feedback` | Record that a handoff was missing or wrong, against the compaction it came from. The bench reads these. |
| `force_compact` | Compact now instead of waiting for the window to fill. |

Four more (`probe_spawn`, `probe_budget`, `ab_fork`, `refresh_handoff`) are
registered only when `COMPACT_HANDOFF_DEV=1`. They exist to measure the engine,
not to be used.

## Install

```bash
git clone https://github.com/AnExiledDev/compact-handoff-plugin.git
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 COMPACT_HANDOFF_LIVE=1 claude --plugin-dir ./compact-handoff-plugin
```

`--plugin-dir` loads it for that session only. To keep it, put the folder (or a
symlink to the clone) at `~/.claude/skills/compact-handoff` and set both
variables in the `env` block of `~/.claude/settings.json`. Without
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` the runtime this is built on does not
exist and the module never loads; without `COMPACT_HANDOFF_LIVE=1` it only
rehearses and the engine's own summariser still runs.

It is written against the type declarations Claude Code prints about itself
(`/plugin-types`, build 2.1.269), published alongside
[cc-changelog-plugin](https://github.com/AnExiledDev/cc-changelog-plugin/tree/main/types).
The ledger, grading and A/B tooling under `bench/` was measured on one private
transcript; the checklist and result tables for it are not in this repository,
only the numbers the README quotes.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `COMPACT_HANDOFF_LIVE` | off | Off, it rehearses and the engine still compacts. On, it answers the event and the engine's summariser never runs. |
| `COMPACT_HANDOFF_DATA_DIR` | `~/.claude/compact-handoff` | Where handoffs, rows and transcripts are kept. |
| `COMPACT_HANDOFF_MODEL` | the session's | The model the commitments pass runs on. An alias (`haiku`) or a full id. |
| `COMPACT_HANDOFF_MAX_CHARS` | unset | An absolute ceiling in characters that overrides the two settings below. Never clamped, because setting it is a deliberate act; past 800000 characters (the 200k-token safe cap) the row records `overSafeCapChars` and `overSafeCapTokens` rather than refusing. The summary is never trimmed, at any size. |
| `COMPACT_HANDOFF_MAX_FRACTION` | `0.25` | The share of the context window a handoff may take, at four characters a token. Values outside (0, 1] fall back to the default. |
| `COMPACT_HANDOFF_MAX_TOKENS` | `150000` | The most a handoff may be in tokens whatever the window, so a million-token window does not hand a quarter of a million up. Clamped to `200000`. The ceiling is min(fraction × window, this) × 4 characters, and `400000` characters when the window cannot be read. |
| `COMPACT_HANDOFF_RESTORE_FILES` | `5` | How many files the summariser may have restored after the handoff. |
| `COMPACT_HANDOFF_RESTORE_FILE_CHARS` | `20000` | The most of one restored file that comes back; the rest is clipped with a note saying how much. |
| `COMPACT_HANDOFF_RESTORE_TOTAL_CHARS` | `100000` | The most all restored files may add together, and never more than the ceiling above leaves free after the handoff. |
| `COMPACT_HANDOFF_MAX_USD_PER_SESSION` | `10` | Past this, compactions fall back to the engine and record `disposition: "overBudget"`. |
| `COMPACT_HANDOFF_SUBAGENTS` | off | Off, a subagent's compaction is passed through with a row saying so. On, it is answered like any other. |
| `COMPACT_HANDOFF_DEV` | off | Registers the four measurement tools. |
| `COMPACT_HANDOFF_REFRESH` | off | Keeps a fallback handoff on disk for sessions a fork cannot serve (headless). |
| `COMPACT_HANDOFF_REFRESH_MS` | `600000` | Shortest gap between two refreshes, and never sooner than 20 new messages. |

## What it costs

Every row carries a `cost`, priced from the table in `hooks/lib.js`. All four
numbers in all seven rows of that table were read on 2026-09-14 off the "Model
pricing" table at <https://platform.claude.com/docs/en/about-claude/pricing>,
which the code records as `PRICES_SOURCE` beside `PRICES_TAKEN`; none of them is
from memory. Usage the host does not report records `cost: null` and a
`costUnknownReason` rather than a zero, so a missing measurement can never be
averaged in as a free one.

The baseline is measured, not estimated. `bench/baseline.py` runs both arms over
one conversation inside one session: first Claude Code's own stock compaction
prompt (lifted from the 2.1.270 binary, committed as `bench/prompts/baseline.txt`)
sent through the very same `$.model.fork`, then a real `/compact` that is this
plugin doing the whole job. Same conversation, same model, same cache state, both
priced off the same table, so neither the model nor the prices can be what the
difference is made of. Baseline first is forced rather than chosen: a compaction
replaces the conversation, so the second arm can only ever see the first arm's
leftovers plus the `/compact` turn itself.

Both rows below are Sonnet 5, 2026-09-14:

| conversation | fixture bytes | cache read | engine's own | this plugin | of which fork | of which commitments |
|---|---|---|---|---|---|---|
| small | 23,532 | 71k tokens | $0.1268 | $0.1220 | $0.0861 | $0.0359 |
| large | 584,947 | 133k tokens | $0.0728 | $0.1567 | $0.0982 | $0.0585 |

**Read those two rows together or not at all.** The obvious reading, that the
plugin is free on a small conversation and costs double on a large one, is not
what happened. At these sizes the input is nearly all cache read and cheap, so
the bill is mostly output, and the engine's own prompt simply wrote a much
shorter summary on the large conversation than on the small one: 10,893 output
tokens against 4,254. That is one run per arm per size and summary length is the
noisiest thing in this whole system, so treat these as the order of magnitude
(both arms are a tenth of a dollar on Sonnet, single digit cents on Haiku) and
not as a stable ratio. What is solid is the shape: the fork is most of the money
and the commitments pass is the rest, and neither depends much on how long the
conversation is.

The nine live checks below cost $2.32 of plugin spend across 37 compactions, on
Haiku 4.5, which is the number to have in mind for everyday use. That total is
the whole bench ledger, including the runs that failed and were fixed, not only
the nine that pass.

## What was verified live

Nine checks, each a real throwaway `claude` session driven through a pty with
`COMPACT_HANDOFF_LIVE=1`, against an isolated `CLAUDE_CONFIG_DIR` and an isolated
data dir. `python3 bench/verify.py run` runs them; `table` prints what they last
measured. All nine pass as of 2026-09-14 on engine 2.1.270.

| # | check | what it proves | measured |
|---|---|---|---|
| 1 | `manual` | a `/compact` is answered and replaced | replaced, 29,236 chars, $0.051735, 83,834 ms |
| 2 | `auto` | an automatic compaction dispatches a real event, not a precompute | `trigger=auto`, `disposition=replaced`, 2 rows, no precompute row, fork warm, source `handoff` |
| 3 | `depth` | two compactions in one session merge the earlier ledger | `depth=2`, `prev=1`, 1 earlier ledger row merged |
| 4 | `instructions` | `/compact <instructions>` reaches the fork | replaced, summary 10,034 chars, ledger 6,781 chars |
| 5 | `blob` | the size guard trims turns and never the summary | 46,646 -> 25,005 chars, 1 turn trimmed, ceiling 30,000, untrimmable handoff 23,178, summary intact |
| 6 | `concurrent` | two sessions compacting in the same minute do not collide | 2 rows from 2 sessions in 1 minute |
| 7 | `tools` | `handoff_lookup` and `handoff_search` work after a compaction | both answered, and the monitor recorded both calls |
| 8 | `resume` | `claude --resume` still carries the handoff | lineage marker present in the resumed transcript, and the session echoed it |
| 9 | `subagent` | a subagent's compaction is passed through with a row | `agentId=a3ed584c4b8e44c8e`, `passedThrough`, reason recorded |

Two things are worth saying about how check 2 was made to work, because both
were wrong for several runs and both look like plugin bugs when they are not.
`autoCompactWindow` is validated to 100k-1M and a value outside that range is
**dropped in silence**, so a bench asking for a 30,000-token window ran on the
1,000,000 default and never compacted at all. And this repo's `CLAUDE.md` pulls
in a very large `AGENTS.md`, so a session here opens around 80k tokens against
that 100k floor: two 10k-token reads crossed the line at ten messages, on the
turn that crossed it, which is the cold-fork case in the limits below rather
than a failure of the automatic path. Given files small enough that turns finish
before the line, the fork is warm on an automatic compaction exactly as it is on
a manual one.

What could not be run: nothing in the list. There is no check for a headless
(`-p` / SDK) compaction because the engine refuses to dispatch one at all, which
is the first known limit below rather than an untested path.

### The commitments pass runs as nobody, and that is measured

Since 0.4.0 the commitments appendix is one `$.model.complete` call: an API
request the engine makes in process, with no session, no settings layers and
no hooks around it, so nothing below can happen to it. The price of that is
the cost. `$.model.complete` hands back the reply text and drops the usage the
API returned, and what it spends never reaches `$.session.usage().cost`, so the
row carries an estimate - prompt and reply at four characters a token, priced
at the model's own rate, no cache terms - labelled `commitmentsCostBasis:
"estimate: chars/4, no cache"`. It is never recorded as 0. The history that
follows is kept because the trap is still real for anyone who spawns the CLI.

Until 0.3.0 the commitments appendix was a `claude -p` call, which is a full session and
loads settings like any other, so every `UserPromptSubmit` hook on the machine
fires on a prompt nobody typed. On this box that meant the operator's intent
ledger recorded ten commitments prompts as sentences they had typed at a
keyboard.

`--setting-sources ""` fixes it by dropping the user, project and local settings
layers outright, which is the whole surface hooks and plugins are declared on.
The first attempt did not: it gave the call a `CLAUDE_CONFIG_DIR` of its own
with an empty `hooks` block, and `CLAUDE_CONFIG_DIR` moves the *user* settings
layer only. The call runs with `cwd` at `$HOME`, so `$HOME/.claude/settings.json`
was still loaded as the *project* layer out of `$cwd/.claude/` - the same file,
through a door the config dir does not close.

Measured on 2026-09-14 against the real ledger, two probes: with the flag, zero
captures; without it, one capture of a prompt nobody typed. Then end to end, one
live `/compact` whose commitments pass really ran ($0.1400, a 12,569-character
prompt, 75.9 s): the ledger held ten before it and ten after.

Dropping the credentials copy that the first attempt needed is worth as much as
fixing the leak. It wrote to one path shared by every session on the box, so two
concurrent compactions raced - one `release()` deleting the file while the
other's `claude -p` still needed it - and a token rotation during the run would
have put the new refresh token in the copy and left the operator's real one
revoked, logging their own sessions out. Credentials are not a settings source,
so the ambient config dir authenticates the call with nothing copied at all.

## Known limits

- **A headless session (`-p` / SDK) gets nothing.** `$.model.fork` returns
  `null` with no warm transcript, and `$.session.compact` refuses outright:
  *"not available in a headless (-p / SDK) session yet"*. The disk fallback
  behind `COMPACT_HANDOFF_REFRESH` exists for this and is off by default.
- **A compaction that lands before any turn has finished forks cold, and that
  is a real thing that happens.** The fork reads the main thread's cache-safe
  snapshot, and there is none until a turn has completed in this process. Two
  live shapes hit it. A session reopened with `--resume` and pushed over the
  window before it has answered anything: measured at 144 ms, `fellBack` /
  `noHandoff` / `forkOutcome: cold`. And a session whose very first substantial
  turn crosses the window while that turn is still in flight: measured four
  times on fresh sessions that compacted ten to fifteen messages in, same three
  fields. Nothing is lost and nothing is silent - the engine's own summary is
  what the session carries, and the row says exactly why. One completed turn is
  enough to fix it, which is why the automatic path is not itself the problem:
  check 2 above forks warm on a `trigger: auto` compaction at 61 messages.
- **A restored file is text or nothing.** Images, PDFs and notebooks the
  session read cannot come back through this path; the row says `failed` with
  the Read tool's reason. The restored pairs are real tool blocks, so the
  transcript viewer shows them as Reads the model made right after the
  handoff, which is what they are.
- **A subagent's compaction is passed through** unless
  `COMPACT_HANDOFF_SUBAGENTS=1`. It is a different conversation with a different
  owner and nothing here has been graded on one.
- **About half of what a summary carries is chance.** Every number above is a
  mean over replicates for that reason, and a difference between two single runs
  is not a result.
- **The unsourced-claim marker is not in this plugin.** `bench/invent.py` tried
  to mark the parts of a handoff nothing in the transcript supports, and failed
  as a measurement: it could not separate a claim the conversation never made
  from a claim it made in different words, so its markers were noise on text
  that was fine. It is left out rather than shipped as a warning nobody can act
  on.
- **`CLAUDE_CONFIG_DIR` does not isolate a subprocess from your settings, and
  the way it fails is quiet.** It moves the *user* settings layer. The *project*
  layer is `$cwd/.claude/settings.json`, so a `claude -p` spawned with `cwd` at
  `$HOME` loads `$HOME/.claude/settings.json` anyway - the same file, as a
  different layer - and every hook in it fires on a prompt nobody typed. An
  empty `hooks` block in the config dir you pointed at does not help, and
  nothing warns you. Anyone copying this pattern should use
  `--setting-sources ""` rather than a config dir, or at minimum spawn with a
  `cwd` that has no `.claude/` above it.
- **The commitments cost is an estimate, not a measurement.** `$.model.complete`
  returns text only and its spend is invisible to `$.session.usage()`, so
  `cost.commitmentsUsd` is characters over four at the model's list price with
  no cache terms, and `cost.commitmentsBasis` says so on every row. Rows from
  0.3.0 and earlier carry the `claude -p` figure the CLI reported and read
  `measured`. Summing a day's rows mixes the two; the basis field is how you
  tell them apart.
- **The commitments reply is capped at 8192 output tokens, and that is a
  behaviour change from `claude -p`.** `$.model.complete` takes a `maxTokens`
  of at most 8192 and stops there without saying so, where the CLI would run
  on. A session with more unkept commitments than fit loses the tail. It does
  not lose it silently: `parts.commitmentsHitCap` is `true` on that row with
  `commitmentsHitCapReason` naming why (`length`, or `truncated row` when the
  last line opens a row and never closes it) and `commitmentsRows` says how
  many came back.
- **The declarations are a version behind the engine.**
  `types/claude-code.d.ts` out of 2.1.269 declares a tool use as
  `{id, name, input}`; 2.1.270 hands a `session.compact` hook
  `{tool_use_id, tool, input, result, text}`. Reading `use.name` yields
  `undefined` for every call and nothing throws — it shipped that way once and
  rendered *"2 tool calls: 0 file writes, 0 shell commands"* over two real Bash
  calls. The ledger reads `use.name ?? use.tool`, and the tests carry fixtures
  for both shapes.

## The bench

`bench/` is how every number here was measured.

```
python3 bench/fixture.py <transcript.jsonl> --target 120000   # a disposable copy
python3 bench/run.py --session <id> --replicates 3 baseline terse
python3 bench/report.py                                        # per-arm cost and size
python3 bench/summarise_runs.py --days 7                       # a week of real compactions
python3 bench/verify.py setup <transcript.jsonl> --target 120000
python3 bench/verify.py run all && python3 bench/verify.py table
python3 bench/baseline.py run --source <transcript.jsonl> --target 120000 --label large
python3 bench/baseline.py table
```

- **`bench/prompts/*.txt` are the arms.** `baseline.txt` is Claude Code's own
  compaction instruction, lifted verbatim out of `pretty-v2.1.270.js`. The
  variant is read off disk inside the hook and never enters the transcript, so
  two arms differ only in what the fork was asked.
- **`bench/summarise_runs.py` reads a week of real compactions** and asks a
  model nothing: cost distribution, which parts failed and why, how deep
  lineages went, what sessions re-ran after a compaction, and every feedback
  note. Costs are the plugin's own priced figures, never re-derived, so this and
  the plugin cannot disagree about what a compaction cost. A row the plugin
  could not price records `null` and a reason, and is counted as unpriced rather
  than as zero: **a total with unpriced rows in it is a floor, not a cost.**
- **`bench/verify.py` drives real terminal sessions** over a pty against an
  isolated `CLAUDE_CONFIG_DIR` and data dir, and asserts on the rows the plugin
  stored rather than on what the terminal printed. A toast on screen is not
  evidence that anything was stored.

Four things about driving a session unattended, each of which cost a run:

- An unattended TUI stops on three dialogs in sequence, each silently eating
  every keystroke meant for the prompt. The auth chooser wants
  `hasCompletedOnboarding` in the config dir's `.claude.json`; the trust dialog
  wants a `projects[<cwd>]` entry with `hasTrustDialogAccepted`; the
  bypassPermissions warning is suppressed by no settings key at all and has to
  be answered — and only `ESC O B` moves its selection, because the TUI puts the
  terminal in application cursor mode.
- A session spawned from inside another inherits `CLAUDE_CODE_CHILD_SESSION` and
  **writes no transcript at all**, so there is nothing to resume and nothing for
  the plugin to read. Unset it, or set
  `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`.
- A session's transcript lives under its own `CLAUDE_CONFIG_DIR`. With
  `CLAUDE_CONFIG_DIR=/x`, `--resume <id>` reads
  `/x/projects/<encoded-cwd>/<id>.jsonl`, not `~/.claude/projects/`.
- `/compact` leaves its own text in the input box, so the next thing typed
  compacts a second time *with instructions*. The first run of these checks
  recorded a row dispositioned `instructed` on the word `/quit`.

## How it works at all

A `session.compact` hook is handed the whole transcript, and what it answers
*is* the conversation afterwards. Return `{ messages }` without calling `next`
and the engine's summariser never runs.

**The handoff is written inside the event**, by `$.model.fork({ prompt })`: one
tool-less completion over the main thread's own cache-safe transcript snapshot,
which is how the engine's own compaction reads a conversation. Nothing has to be
marshalled in and the prompt cache is already warm. It answers `{ text, usage }`,
or `null` when there is no warm transcript.

That works despite the ten second dispatch budget, because **a host op's time in
flight does not count against it.** Every `$` call crosses the ops bridge, and
the bridge pauses the budget timer while the op is out. The ten seconds are the
hook's own compute, not its wall clock:

| probe | result |
| --- | --- |
| `tool.call`, `$.clock.sleep` loop on a file nobody writes | `elapsedMs: 10052`, `aborted` |
| `tool.call`, `$.process.run(["sleep","30"])` | `elapsedMs: 30018`, `aborted: false` |
| `turn.complete`, `$.model.fork` | `elapsedMs: 21768`, `aborted: false` |
| a real `/compact` forking inline | `elapsedMs: 21116`, `replaced`, `aborted: false` |

The first row is the trap that hid this: `$.clock.sleep` is a local timer, not a
host op, so that loop really did burn the budget. The engine's constant is
`var BSe = 1e4`, a literal with no env var, flag or settings key behind it, and
plugin handlers never carry the `budgetMs` override the engine's own handlers
use. Ten seconds cannot be raised. It just does not mean what it looks like.

**A precompute is declined on purpose.** The engine can build a compaction
before it needs one and keep it for the compaction that comes. Waving that
through was a hole: an automatic compaction could be served an engine summary
this plugin had approved, and no row would ever say so. The precompute trigger
now answers `{ skip }`, which forces the engine to dispatch a real event when it
actually compacts.

## The static scan, as it bit here

- **A function that takes `$` may not share its name with anything else in the
  file.** A helper `path($, relative)` beside a local `const path = ...` fails
  with *"the function handed $ `path` is declared more than once in this file"*.
- **`$.env.get` takes a literal name**, so the variables a module reads can be
  listed. A constant holding the name fails with *"got the variable LIVE_ENV"*.
