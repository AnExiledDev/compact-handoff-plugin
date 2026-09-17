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
   The fork is also asked to reason in `<analysis>` tags before it writes, and
   **since 0.4.2 that block is dropped before the handoff is assembled**. It is
   still asked for, because the arm that reasons first is the one the bench
   picked and Round 3 measured that taking work away from this model backfires;
   it is thrown away afterwards instead. Across the 31 handoffs stored on the
   machine it was written on, it ran 14% of the summary's characters on average
   and 46% at its worst, and it is deliberation rather than findings: it plans
   the summary, and it corrects itself mid-paragraph, which the next window has
   no way to read as discarded. The `<summary>` wrapper tags go with it.
   `analysisChars` on the row says how much was dropped. A block the model never
   closed is left alone unless a summary follows it, because a reply cut off
   inside the scratchpad has nothing else in it.
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
5. **Every user turn, verbatim**, selected by the engine's own `handle` and
   handed back as its words alone, so nothing is rebuilt from a paraphrase.
   Until 0.7.0 the turn went back *with* its handle, which hands the engine's
   own copy up whole, and that copy carries every attachment the turn arrived
   with: the instruction bundle (CLAUDE.md, every rule file, AGENTS.md,
   MEMORY.md), the hook outputs, the skill and agent listings. Measured on
   2026-09-17 (session 7c6495a3, depth 8): a 22.7k-character handoff came back
   as a 124k-token first turn, and 218k characters of it were four copies of
   the instruction bundle riding on 19 pinned turns, one of them a 44k-character
   AGENTS.md. The engine re-emits that bundle on its own after a compaction, so
   every copy said the same thing twice. A turn without its handle is the
   person's words and nothing else; the `hook_additional_context` lines those
   turns carried (the intent ledger's `op:` ids here) go with the attachments.
   Measured live on 2026-09-17 (engine 2.1.274, the bench's `tools` check):
   the transcript after the boundary held the handoff and two pinned turns of
   2,155 and 577 bytes with nothing attached to them, the engine re-emitted
   its instruction bundle once, and the first real turn cost 58k tokens
   where 0.6.0 had cost 124k. (`withHandles` is a field of the forced-run
   record `compact_force` writes to `runs.jsonl`, not of the index row.)
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
  window.jsonl                       one occupancy reading per turn, every session
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

### What carrying a handoff costs to read

A compaction row says what a handoff cost to *write*. `window.jsonl` says what
it costs to *carry*, and it is the only file here written by sessions that never
compact at all:

```
~/.claude/compact-handoff/window.jsonl
```

One row per completed turn, whatever the session: `at`, `session`, `turn`,
`first`, `phase` (`fresh` or `post-compact`), `compaction`, `tokens`, `window`,
`percent`, `messages`, `handoffChars`, `handoffTokens`, `handoffPercent`.
Nothing is sampled and nothing is conditional, because the comparison only works
if both arms are there.

The reading that matters is `first: true`. On a `fresh` session that is the
floor every window pays before any work happens: system prompt, `CLAUDE.md` and
`AGENTS.md`, the tool declarations, the first message. On a `post-compact`
session it is that same floor plus the handoff and its restored files. The
difference between the two is the handoff's real price, and `handoffPercent` is
the handoff's own share of the window, so the two together separate what this
plugin costs from what the rules files cost. Added in 0.4.2 at the operator's
direction: *"This tells us how much context is our compaction summary vs claude
rules and similar."*

`percent` is computed to one decimal from `tokens / window`; the engine's own
whole-number figure is the fallback when a reading carries no window.

**It wrote nothing at all until 0.4.3.** The reading was taken off the
`turn.complete` event's own `messages`, and that event carries no transcript:
it is `answer`, `durationMs`, `aborted`, `turnId` and `reason`, whatever the
declarations imply. So every turn on engine 2.1.273 threw a `TypeError`, the
engine printed `turn.complete hook skipped: threw` and no row was ever
appended. The transcript comes from `$.session.messages()` now, which costs a
host round trip per turn, and a turn whose transcript cannot be read still
writes its row with `messages` and the handoff fields null.

### Reading one row

A row says what the compaction did and, when it did not do it, why. The fields
that matter for that second case:

| field | when | what it says |
|---|---|---|
| `disposition` | always | `replaced`, `rehearsed`, `fellBack`, `passedThrough`, `overBudget`, `abortedFallback` |
| `fallbackReason` | every disposition but `replaced` | one line naming why, e.g. `noHandoff: no handoff has been written yet (fork cold: the fork found no warm main-thread transcript)` |
| `cost` | always | `{forkUsd, commitmentsUsd, commitmentsBasis, totalUsd, cacheReadWaivedUsd, basis, forkUsage, model, priced, pricesTaken}`, or `null`. Since 0.4.1 cache reads are stored in `forkUsage.cacheRead` and priced into `cacheReadWaivedUsd` at list, and never added to `forkUsd` or `totalUsd`, because on a subscription they cost nothing; `basis` says so. Rows from 0.4.0 and earlier charged them. `commitmentsBasis` is `estimate: chars/4, no cache` since 0.4.0, `none` when no commitments pass ran, `measured` on rows from 0.3.0 and earlier |
| `maxHandoff` | every `replaced` and `rehearsed` row | the handoff ceiling the size guard used and how it was arrived at: `{window, fraction, capTokens, chars, decider}`, where `decider` is `fraction`, `cap`, `default: window unknown` or `override`; an override past the safe cap adds `overSafeCapChars` and `overSafeCapTokens` saying by how much |
| `forkInput` | every row, `null` on the rows that never forked | what the fork was charged to read against what the session holds: `{sent, cacheRead, contextTokens, matchesContext}`. `sent` is input plus cache read plus cache write, which is the whole conversation for a warm fork and a prefix for a cold one; `matchesContext` is false when `sent` falls more than a fifth short of `contextTokens`, and that is the reading that refuses the fork's answer (`forkOutcome: "mismatch"`). Added in 0.6.0 |
| `forkContext` | every row that forked | what the session looked like the instant before `$.model.fork`: `{context, model, messages, msSinceLastFork, subagentRanThisTurn}`, where `context` is the whole `$.session.usage().context` object (`tokens`, `window`, `percent`) and `msSinceLastFork` is `null` on a session's first fork |
| `parts` | every `replaced` and `rehearsed` row | per-part sizes and timings; for the commitments pass, `commitmentsVia`, `commitmentsModel`, `commitmentsPromptChars`, `commitmentsReplyChars`, `commitmentsTokensEstimated`, `commitmentsCostUsd`, `commitmentsCostBasis`, and since 0.4.0 `commitmentsRows` (how many rows came back) with `commitmentsHitCap` and `commitmentsHitCapReason` (`length` or `truncated row`) saying whether the reply stopped at the 8192-token output cap |
| `seam` | every row this plugin handled itself | `{subscribers, results}`, where each result is `{name, outcome, elapsedMs}` and `outcome` is `ok`, `threw` or `timedOut`; `{subscribers: 0}` alone when nothing subscribed. Absent on `passedThrough` and `overBudget` rows, which never reach the seam |
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
claude plugin marketplace add AnExiledDev/compact-handoff-plugin
claude plugin install compact-handoff@compact-handoff
```

Since 0.4.3 this repository is its own marketplace. `.claude-plugin/marketplace.json`
lists one plugin whose `source` is the repository root, so those two commands are
the whole install on a machine that has never seen it, and neither of them needs
a clone. The marketplace is called `compact-handoff` after the only plugin it
carries, which is why the install id reads `compact-handoff@compact-handoff`.
`claude plugin install` writes user scope unless you pass `--scope project` or
`--scope local`. Claude Code picks the install up on its next launch, or on
`/reload-plugins` in a session that is already open.

Two environment variables belong in the `env` block of `~/.claude/settings.json`,
and the install does not write them for you:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "COMPACT_HANDOFF_LIVE": "1"
  }
}
```

Without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` the runtime this is built on does
not exist and the module never loads. Without `COMPACT_HANDOFF_LIVE=1` it
rehearses: it does the whole job, writes down the handoff it would have handed
up, and then lets the engine compact anyway. Rehearsing stays the default after
an install on purpose. The worst case of installing something that replaces your
compaction should be the compaction you already had, so turning it live is a
second, deliberate act.

To work on the plugin rather than use it, `--plugin-dir` still loads a folder for
one session and takes precedence over the installed copy of the same name:

```bash
git clone https://github.com/AnExiledDev/compact-handoff-plugin.git
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 COMPACT_HANDOFF_LIVE=1 claude --plugin-dir ./compact-handoff-plugin
```

### Upgrading

```bash
claude plugin marketplace update compact-handoff
claude plugin update compact-handoff@compact-handoff
```

The first refreshes the catalog from GitHub and the second moves the install to
the version it now names; restart, or run `/reload-plugins`, to load it. Pulling
a clone upgrades nothing any more, because what runs is the copy the install put
under `~/.claude/plugins/cache/`, and a clone is only what `--plugin-dir` reads.

### Why not `~/.claude/skills/`

Claude Code will load a plugin placed at `~/.claude/skills/<name>/`, and until
0.4.3 this file said to install it that way, as a symlink to a clone. Do not. A
plugin loaded out of the skills directory was measured sitting inner on the hook
chain, the skills directory is not a documented way to install anything, and what
orders two plugins loaded that way was never identified. Renaming did not move
one: `aa-probe`, which sorts before `compact-handoff`, and `zz-probe`, which
sorts after, behaved identically. The marketplace install at the top of this
section is the documented path, it is the same on every machine, and it carries a
version `claude plugin update` can move.

Where a plugin sits in the chain matters more for this plugin than for most,
because it answers `session.compact` with the compacted conversation and never
calls `next`. Whatever sits beneath it on that event is never dispatched at all.

**Within the `user` tier, chain position is the key order under `enabledPlugins`
in `~/.claude/settings.json`, first key outermost.** Measured on 2026-09-16
against engine 2.1.273, over two real compactions, with this plugin and a probe
plugin both installed from marketplaces at user scope. With the probe's key
placed above `compact-handoff@compact-handoff`, the probe's `session.compact`
hook was dispatched, its `next.trace` held exactly one link (`compact-handoff`,
tier `user`, outcome `returned`, 20473.8 ms), its own fork of the pre-compaction
transcript answered in 1957 ms, and this plugin still wrote
`disposition: "replaced"`. Moving the probe's entry to the front of
`~/.claude/plugins/installed_plugins.json` while leaving the settings key where
it was did nothing at all: the hook was never dispatched, while that same probe's
`session.start`, `tool.call` and `turn.complete` hooks all ran in that session.

**Since 0.4.3 that is the answer for a second plugin that has to see a
compaction. Its `enabledPlugins` key has to sit above
`compact-handoff@compact-handoff`, and the only way found to put it there is to
edit `~/.claude/settings.json` by hand.** `claude plugin install` appends a new
plugin last in both files, which is why a plugin installed after this one never
receives `session.compact` at all. Three things are worth knowing before you lean
on it. No CLI flag for placing a key first was found. Whether a later `claude
plugin install`, `enable` or `disable`, or a settings write by the TUI, moves a
hand-placed key back to the end has not been tested, so read the order back after
any of those. And only a manual `/compact` was exercised, so the `auto`, `plugin`
and `precompute` triggers are unmeasured, as is a chain of three. Nothing read
the engine's code for any of this: it is a measured relation between input and
output on 2.1.273 and it could change in any release.

Both write-ups are private and neither is in this repository.

Since 0.6.0 a second plugin has another way in that does not depend on the key
order at all. It subscribes to the seam this plugin exposes, and the next
section is how.

This plugin is written against the type declarations Claude Code prints about
itself (`/plugin-types`, build 2.1.269), published alongside
[cc-changelog-plugin](https://github.com/AnExiledDev/cc-changelog-plugin/tree/main/types).
The ledger, grading and A/B tooling under `bench/` was measured on one private
transcript; the checklist and result tables for it are not in this repository,
only the numbers the README quotes.

## Working beside another plugin

Alone, this plugin is the whole compaction. It answers `session.compact` with
the conversation it wants the session to carry and it never calls `next`, so the
engine's summariser does not run and neither does anything sitting beneath it on
that event. That is what it is for, and it is also the problem: a second plugin
that wants to read a conversation the moment before it is compacted has nowhere
to stand. Within the `user` tier the chain order is the key order under
`enabledPlugins` and `claude plugin install` appends last, so a plugin installed
after this one is never dispatched `session.compact` at all. The measurement is
in the section above.

Since 0.6.0 there is a seam for exactly that plugin. This one adds a noun to `$`
through an `engine.create` fold, which is the fold that builds `$`, and the
declarations say every noun a plugin's step adds is on every plugin's `$`:

```js
$.compactHandoff = {
    beforeCompact({ tool, name }),  // resolves { subscribed: true, tool }
    version(),                      // resolves "0.9.0"
};
```

**The seam carries strings and nothing else.** `tool` is the full name of a tool
your plugin answers with a `tool.call` hook of its own. When a compaction starts,
this plugin raises that tool:

```js
$.tool.call({ tool, trigger, messageCount });
```

Your hook then runs in your plugin's own environment, which is the whole reason
the seam is shaped this way. 0.5.0 took a callback and a callback cannot cross
this boundary at all: each plugin runs in its own environment, an interface
call's arguments go through `cloneInto`, and `cloneInto` throws `DataCloneError`
on a function. The engine's static scan refused both modules outright in the
same run, before any of that could even be reached. Strings clone. Functions do
not.

The transcript does not travel either, and that is deliberate. `messageCount` is
a number, the messages stay where they are, and your hook reads the conversation
the way this plugin does, with `$.model.fork` over the live session. It is the
same pre-compaction transcript and the same warm cache. Measured during the spike
that led to this, on a 57k transcript, a second fork beside this plugin's own
cost $0.0012 waived and took about 2 seconds, against $0.4995 for the same fork
taken from `turn.complete` after the compaction had already happened. Cloning a
megabyte of messages across the boundary would buy nothing a fork does not
already give you.

Here is a whole subscriber, written the way the memory plugin writes it, so that
it still works with this plugin absent:

```js
const SEAM_TOOL = "mcp__memory-handoff__before_compact";

export const register = (on) => {
    on("session.start", async ($, e, next) => {
        try {
            await $.compactHandoff.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });
            await $.store.set("seam", { present: true, at: Date.now() });
        } catch (error) {
            // With compact-handoff absent there is no such noun, and reading it
            // throws a TypeError. That throw is the detection.
            await $.store.set("seam", { present: false, detail: String(error), at: Date.now() });
        }

        return next(e);
    });

    // The raise lands here, in this plugin's own environment, where a fork and
    // a database and anything else this plugin owns all work normally.
    on("tool.call", { tool: SEAM_TOOL }, async ($, e) => {
        const outcome = await remember($, e.trigger, e.messageCount);

        // Never `next(e)`. The call exists for this hook and for nothing else.
        return { result: { outcome } };
    });

    on("session.compact", async ($, e, next) => {
        const seam = await $.store.get("seam");

        // Subscribed, so the raise is bringing this same compaction along in a
        // moment and working here as well would be two passes for one
        // compaction.
        if (seam?.present !== true) {
            await remember($, e.trigger, e.messages.length);
        }

        return next(e);
    });
};
```

Write the calls out longhand, exactly as they are above. The engine scans a
hooks module before it loads it and refuses `$.compactHandoff?.beforeCompact`,
`const seam = $.compactHandoff`, and anything else that reads a noun of `$`
rather than calling an event on it. Both of those spellings are why there is no
`typeof` check here: the try/catch is the check.

### The seam is typed, not just described

Since 0.8.0 the manifest names a type contract, `types/compact-handoff.d.ts`,
and it is the same two signatures the snippet above shows, written where a
compiler can read them:

```json
"types": "./types/compact-handoff.d.ts"
```

Run `/plugin-types` in the subscriber's own checkout. It copies this file
verbatim to `.claude/types/claude-code-plugins/compact-handoff.d.ts` under a
banner naming this plugin, its version and its tier, and references it from
`.claude/types/claude-code-plugins.d.ts` beside it. Point the subscriber's
`tsconfig.json` or `jsconfig.json` at that folder:

```json
"include": [".claude/types", "hooks"]
```

and `$.compactHandoff.beforeCompact({ tool })` is typed in the subscriber with
nothing copied and nothing to keep in step by hand. A contract that could not
be read, or did not itself typecheck, is listed at the end of the index with
the reason rather than silently skipped, and `claude plugin validate` checks it
before any of that: it answers `types ./types/compact-handoff.d.ts declares on
$: $.compactHandoff`.

The generated folder is not committed here. It is a per-project index of
whatever plugins that project has enabled, so it belongs in `.gitignore`, which
is where this repo puts it.

`name` is what the row calls the subscriber and it defaults to the tool name.
Name it anyway. Subscribing twice for one tool is subscribing once, so a plugin
reload costs nothing, and there is no unsubscribe: a subscription lives for as
long as the session does.

What the seam will and will not do to you:

- A raise that throws is a field on the row and changes nothing else. This
  plugin's own outcome is the same either way, and the test that pins that
  compares both rows against a run with nobody subscribed.
- A hook that answers `{ deny }` is recorded as `denied` with the refusal on
  the row. Denying is a legitimate answer and it costs the compaction nothing.
- A raise still pending after `COMPACT_HANDOFF_SEAM_TIMEOUT_MS` (default
  `90000`) is abandoned. Nothing here can cancel one, so it is left running, its
  answer is ignored and the compaction goes on.
- Nothing is raised on a compaction this plugin only passes through. A
  subagent's compaction and a session already over its budget are handed back to
  the engine before the seam is reached, and those rows carry no `seam` field at
  all.
- With nobody subscribed the seam is one array copy and the row says
  `seam: { subscribers: 0 }`. No environment read, no timer, no cost.

The row carries what happened:

```json
"seam": {
  "subscribers": 1,
  "results": [
    {
      "name": "memory-handoff",
      "tool": "mcp__memory-handoff__before_compact",
      "outcome": "ok",
      "elapsedMs": 2104
    }
  ]
}
```

`outcome` is `ok`, `denied`, `threw` or `timedOut`. A `denied` carries the
refusal as `detail` and a `threw` carries the first 300 characters of the error,
and `elapsedMs` is measured from the moment the tool was raised, so a `timedOut`
reads a little over the cap.

[memory-handoff](https://github.com/AnExiledDev/memory-handoff-plugin) is the
first subscriber. Either plugin runs with the other absent, which is the point of
building it this way: with this plugin uninstalled, the memory plugin takes its
own fork from its own `session.compact` hook and hands the compaction back to the
engine, and with the memory plugin uninstalled the seam here has zero subscribers
and costs nothing.

Both halves of that are measured on engine 2.1.273 (2026-09-16). The noun this
plugin adds at `engine.create` does reach the memory plugin's `$`: its
`session.start` subscribed through `$.compactHandoff.beforeCompact` in about
2 ms and read `0.6.0` back from `version()`. And a raised tool has to be
registered: raising `mcp__memory-handoff__before_compact` before the memory
plugin registered it came back refused with `$.tool.call: no tool named
"mcp__memory-handoff__before_compact" in this session`, and once registered the
raise reached the hook and answered `ok` in 6030 ms, inside a compaction whose
own fork took 19293 ms. Both forks read the same warm cache, 50630 of 50961
input tokens on each row. The seam never shows up in the session transcript as
a tool use, though the registered tool is listed to the model, and the memory
plugin denies any call that does not carry the seam's own fields. Should the
noun fail to reach another plugin's `$` on your build, the `enabledPlugins`
order documented above is measured and it works.

## The handoff writer is a declared agent type

Since 0.9.0 the fork that writes a handoff is an agent type this plugin declares
rather than an anonymous `general-purpose` spawn carrying its instructions in the
turn. `session.start` calls `$.agent.register` and the engine hands back
`compact-handoff:handoff`, which `$.agent.spawn` then names.

Three things move from the prompt into the spec, where the engine enforces them
instead of the fork choosing to comply:

- `tools: ["Read", "Write", "Grep", "Glob"]`. The writer reads one transcript and
  writes one file. It could never edit, run a command or spawn anything, and now
  it cannot be asked to.
- `omitClaudeMd: true`. The writer needs the transcript, never the project's
  instructions, and this repo's `CLAUDE.md` pulls in an `AGENTS.md` large enough
  to matter against a cold fork's window (see check 2 above). Dropping it is the
  single largest cut to what the fork is charged to read.
- `background: true`. The handoff is written between turns; it was already
  running out of band and the spec says so.

The standing instructions live in the spec's `prompt`, so the turn the fork
receives is two lines: the transcript path and where to write the answer.

**A registration that does not take loses the agent type, never the handoff.**
`session.start` records the outcome in the plugin's store, `handoff_status`
reports it under `agent`, and a false reading routes the spawn back to
`general-purpose` with the standing instructions folded into the turn exactly as
before 0.9.0. Nothing about a refused registration is silent and nothing about it
stops a compaction.

The type is registered and then hidden: `on("agent.offer", { agent:
"compact-handoff:handoff" }, () => ({ isOffered: false }))` keeps it out of the
Agent tool's list, because a session that delegates its own work to the handoff
writer gets a handoff, not the work. `$.agent.spawn` still reaches it by name.

Both halves are verified live on engine 2.1.274 (2026-09-17), in a headless
session with nothing but this plugin loaded. `handoff_status` answered
`{"registered": true, "agent": "compact-handoff:handoff"}`, and asked to list
every `subagent_type` the Agent tool offers, the same session named five and
`compact-handoff:handoff` was not among them.

What the test suite cannot reach: `claude plugin test` supplies no engine
implementation for `agent.register` at all, so the engine's own schema never sees
the spec there. `engine-test/agent.test.ts` covers the two shapes that are
testable — the spec this plugin sends, and the fallback when the registration is
refused — and the live check above covers the third.

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
| `COMPACT_HANDOFF_SEAM_TIMEOUT_MS` | `90000` | How long one raised seam tool may run before the compaction goes on without it. Read only when something is subscribed. |
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

### A warm fork and a cold fork cost differently, and only one of them works

`$.model.fork` is documented to run over this session's own cache-safe
transcript snapshot, and when it does, the fork is **warm**: it is charged for
the whole conversation at the cache-read rate, so `forkInput.sent` lands at or
just above `forkInput.contextTokens` and almost all of it is `cacheRead`. That
is the cheap case the cost table above was measured in.

Some forks come back **cold** instead. The fork is charged for a prefix and for
tens of thousands of *uncached* input tokens, and it answers over a transcript
that is not this conversation. Across the 24 rows in one box's `index.jsonl`
carrying both readings, the split is clean and there is nothing in between: the
ten cold forks were charged for 0.40 to 0.47 of their session's context (65k to
78k sent against 164k to 167k held), the fourteen warm ones for 1.01 to 1.04 of
theirs. Cold forks cost **more** than warm ones, because a cache miss is charged
at the full input rate: each of those ten paid for 40k to 52k *uncached* input
tokens, against 15k to 20k of cache read.

The reply reads like any other summary, so nothing but `forkInput` can tell.
Since 0.6.0 a fork whose input is more than a fifth short of the context is
refused: the row records `forkOutcome: "mismatch"` with the two numbers, the
compaction falls back to the handoff on disk, and the tokens the fork already
spent stay on the row and are priced, because they were spent either way.

Every cold row measured so far was a `trigger: auto` compaction of a session
holding 164k tokens or more, and all ten are paired with a second
`session.compact` dispatch carrying an `agentId`, 0.07 to 0.17 seconds later,
over a transcript one message shorter and with one more pinnable turn in it.
None of the fourteen warm rows has such a partner.
`SessionCompactInput.agentId` is declared as "the id of the loop compacting,
for a subagent's **or a fork's** own transcript". `notes/design/compact-handoff-cold-forks.md` in the
`claude-investigations` repo holds the measurement and what it could not show.

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
- **Every timing on a row written before 0.4.3 is `null`, and cannot be
  recovered.** `$.clock.now()` is declared `() => number` and returns a
  **Promise** at 2.1.273, so `now() - startedAt` was `NaN` and `JSON.stringify`
  wrote it as `null`: `elapsedMs`, `restore.ms` and every `parts.*Ms`, on 71 of
  the first 72 rows on the machine this was written on. The same arithmetic
  drove three deadlines, so an abandoned pending handoff was never cleared, a
  refresh was never due on elapsed time, and `waitForFile` never reached its
  budget. Every duration is `Date.now()` since 0.4.3, which is right whichever
  the engine returns, and a stamp stored by an older version is read as no
  reading rather than compared against.

## Tests

Two suites, two runners, and both have to pass:

```
bun test                # the module's own functions, against a stub $
claude plugin test .    # the plugin loaded into a real engine
```

`bunfig.toml` pins `[test] root = "test"`, and that is load-bearing rather than
tidy. Bun's positional argument is a substring filter and not a directory, so
`bun test test/` still matches `engine-test/`, and the run fails with `Cannot
find module 'claude-code/testing'` on a suite that was never meant for it.

`claude plugin test` runs every `*.test.ts` under the plugin root, each file in
a child of the binary, in an environment like the one the hooks run in. That
buys the one thing a stub `$` cannot: the seam resolved through a live engine,
with this plugin's `engine.create` fold actually folded and a subscriber
actually beneath it. `engine-test/seam.test.ts` is that test, and breaking the
fold (dropping `version` from the noun) turns all three red with
`$.compactHandoff.version is not a function`.

Two shapes in there are forced by the engine rather than chosen:

- **The subscriber is an inline plugin (`{ plugins: [probe] }`), not a hook
  registered in the test body.** The static scan reads `$.<noun>.<event>` off a
  hooks module's `register`; a hook closed over by a test body is never scanned,
  and every call it makes on another plugin's noun is refused at the call site
  with `its hooks module does not call it`.
- **That `register` closes over nothing,** not even a `const` at the top of the
  file. It is loaded the way a module is, and a name from the test file's scope
  fails with `PROBE_TOOL is not defined`. What the probe learns comes back out
  through the tool result.

## The eval suite

`evals/` is a third runner, and unlike the two above it costs money and answers
a different question: not whether the code is right, but whether an agent that
has this plugin loaded actually reaches for it.

```
claude plugin eval . --ablation with-without --no-publish \
  --allow-tools 'mcp__compact-handoff__*'
```

Three cases, two runs each, both arms: about **$0.55** a suite on 2.1.274, and
no LLM graders at all, which is why it is that cheap. Every grader is `regex` or
`tool_used`, so the whole score is free and the only spend is the agent runs
themselves. The headline number is Δ, the with-plugin score minus the
no-plugin baseline.

- `01-handoff-status` asks what would happen if the conversation compacted right
  now. Δ +0.50: the baseline can still say the word "compaction", it just cannot
  answer.
- `02-search-history` asks it to search everything stored from before a
  compaction. Δ +0.75, and the second grader is the interesting one — it fails a
  run that *invents* an answer instead of saying nothing was stored, which the
  baseline did once in two runs.
- `03-neg-plain-question` asks for a haiku. Δ 0.00 on purpose: it is the guard
  that having these tools loaded does not make an agent call them at a prompt
  that has nothing to do with them.

A negative case is not padding. A plugin that fires on everything is a
regression this suite is meant to go red on, and `tool_used` with `min: 0`,
`max: 0` and `arm: both` is the shape that catches it.

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
- **`baseline.txt` is still current.** 2.1.274 ships three compaction prompts
  where 2.1.270 shipped one, and the full-history prompt among them is
  byte-identical to this file (`diff`, exit 0). The two that are new are
  committed beside it: `recent274.txt` summarises only the tail because the
  engine now keeps earlier messages intact, and `handoff274.txt` is written to
  sit at the *start* of a continuing session. Neither replaces `baseline.txt` as
  the arm to measure against, because neither is what a full compaction runs.
- **`bench/compare274.py` puts all four side by side** — the three stock prompts
  and the plugin — over one fixture in one session, and `bench/page274.py`
  renders the row as a single self-contained HTML page:

  ```
  python3 bench/compare274.py setup <transcript.jsonl> --target 60000
  python3 bench/compare274.py run
  python3 bench/compare274.py page --out /tmp/compaction.html
  ```

  One caveat the page repeats, because it bounds what the run proves:
  `$.model.fork` appends one user message to the *whole* session transcript and
  offers no way to hand it only the tail, so the `recent274` arm reads the same
  conversation the others do. It measures what that prompt's instructions
  produce, not what the engine's kept-tail path produces.
- **None of the three reaches a `session.compact` hook.** The 2.1.274
  declarations hand the hook the whole transcript under `messages` and carry no
  kept-tail field, so the engine's prompt split is internal to the path this
  plugin replaces and changes nothing about what it does.
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

Five things about driving a session unattended, each of which cost a run:

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
  `/x/projects/<encoded-cwd>/<id>.jsonl`, not `~/.claude/projects/`. The
  encoding turns every character that is not a letter or digit into `-`, and
  the bench derives the directory from the cwd it spawns with rather than
  naming it, because a name guessed for one checkout answered "No conversation
  found" from a worktree of this repo (2026-09-17).
- The cwd is the checkout the plugin sits inside, found by walking up to the
  nearest directory with `plugins/` and a `.git`. Two parents up was wrong from
  a worktree of this repo: it landed in `plugins/compact-handoff/.claude`,
  whose CLAUDE.md lookup walked up to the checkout's `@AGENTS.md` and raised
  engine 2.1.274's "Allow external CLAUDE.md file imports?" dialog, which the
  `hasClaudeMdExternalIncludes*` keys seeded for that cwd did not suppress. The
  bench answers that dialog too if it appears, before the bypass warning.
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
