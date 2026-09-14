/**
 * compact-handoff: everything a handoff is built out of that needs no `$`.
 *
 * Split out of `module.js` so it can be tested. The runtime loads a sibling
 * import: `import { x } from "./lib.js"` inside a plugin's `hooks/module.js`
 * resolves and runs in a real session, verified 2026-09-14 against build
 * 2.1.270 with a probe plugin that wrote the imported value to disk. The static
 * scan `claude plugin validate` runs accepts it too, which is the cheaper half
 * of that check and on its own would have proved nothing.
 *
 * Everything here is a pure function of its arguments. Nothing reads the clock,
 * the filesystem, the environment or the session. That is the whole point: the
 * parts of a compaction that can be wrong in a way a test can catch live here,
 * and the parts that can only be wrong against a live engine live next door.
 */

/** Longest tool argument kept in the ledger; enough for a real command line. */
export const LEDGER_ARG_CHARS = 300;

/** Longest error line quoted back. */
export const LEDGER_ERROR_CHARS = 200;

/** How much of a tool result is scanned for an error shape. */
export const ERROR_SCAN_CHARS = 4000;

/** Longest assistant turn fed to the commitments pass. */
export const COMMITMENT_TURN_CHARS = 6000;

/** Ceiling on the whole commitments prompt; oldest turns drop first. */
export const COMMITMENT_PROMPT_CHARS = 400_000;

/**
 * What an error looks like in a tool result that carries no error flag.
 *
 * A missing `isError` does not mean a command succeeded. The one genuinely
 * failed command in the Round 3 fixture wrote `ugrep: warning: ...: No such
 * file or directory` to stdout, with empty stderr and no flag anywhere, and
 * every arm that trusted the flag reported it as a success.
 */
export const ERROR_SHAPE =
    /^.*\b(?:no such file or directory|command not found|permission denied|fatal:|error:|warning:|traceback \(most recent call last\)|cannot access)\b.*$/imu;

/** The argument worth naming for a tool call, in the order worth trying. */
export const LEDGER_KEYS = ["command", "file_path", "path", "pattern", "url", "description"];

/** One parsed row of the commitments pass. */
export const COMMITMENT_ROW = /^\s*(UNKEPT|CORRECTED|UNANSWERED)\s*\|\s*T(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$/iu;

export const COMMITMENT_HEADING = {
    unkept: "Said it would, no evidence it did",
    corrected: "Claims corrected or withdrawn",
    unanswered: "Questions put to the user and never answered",
};

/* ------------------------------------------------------------------ *
 * Which user turns a person actually typed.
 * ------------------------------------------------------------------ */

/**
 * The user-role turns nobody typed, by the shape they actually arrive in.
 *
 * These are counted, not guessed. A sweep over every session JSONL on this box
 * (2026-09-14) classified the opening of every user turn that carries no tool
 * result: 2199 continuation prompts, 1993 task notifications, 613 slash-command
 * envelopes, 410 local command outputs, 31 cross-session messages and 14 idle
 * notices. A filter written from memory would have missed the two that matter
 * most here, because a cross-session message never starts with its own tag: the
 * harness puts "Another Claude session sent a message:" in front of it.
 *
 * The /loop wakeup is deliberately absent. A wakeup re-fires the user's own
 * `/loop` prompt verbatim, so the turn it produces IS the person's words and
 * pinning it is right.
 */
export const NON_PERSON = [
    { kind: "cross-session", test: (text) => text.includes("<cross-session-message") },
    { kind: "task-notification", test: (text) => text.startsWith("<task-notification") },
    { kind: "idle-notice", test: (text) => text.startsWith("[Cross-session idle notice]") },
    { kind: "command-output", test: (text) => text.startsWith("<local-command-stdout>") },
    { kind: "system-reminder", test: (text) => text.startsWith("<system-reminder>") },
    {
        kind: "continuation",
        test: (text) => text.startsWith("This session is being continued from a previous conversation"),
    },
    { kind: "interrupt", test: (text) => text.startsWith("[Request interrupted by user") },
];

/**
 * Who produced a user turn: the person at the keyboard, or the harness.
 *
 * A slash-command envelope (`<command-name>/clear</command-name>`) counts as the
 * person. They typed it, and `/loop keep going` carries the whole instruction in
 * its arguments; dropping those would lose real intent to save a line.
 */
export const originOf = (message) => {
    const text = (message.text ?? "").trim();

    for (const { kind, test } of NON_PERSON) {
        if (test(text)) {
            return kind;
        }
    }

    return "person";
};

/**
 * Whether a message is a user turn worth keeping verbatim: a person said it,
 * the engine will vouch for it, and it is not the transcript's way of carrying
 * a tool result back to the model.
 */
export const isPinnable = (message) =>
    message.role === "user" &&
    typeof message.handle === "string" &&
    (message.text ?? "").trim() !== "" &&
    (message.toolResults === undefined || message.toolResults.length === 0) &&
    originOf(message) === "person";

/**
 * The user turns the engine would vouch for that a person did not type, by kind.
 *
 * Recorded per compaction so a filter that starts dropping real turns shows up
 * as a number moving rather than as a session quietly losing its instructions.
 */
export const pinSkipCounts = (messages) => {
    const counts = {};

    for (const message of messages) {
        if (message.role !== "user" || typeof message.handle !== "string") {
            continue;
        }

        if ((message.text ?? "").trim() === "") {
            continue;
        }

        if (message.toolResults !== undefined && message.toolResults.length > 0) {
            continue;
        }

        const kind = originOf(message);

        if (kind !== "person") {
            counts[kind] = (counts[kind] ?? 0) + 1;
        }
    }

    return counts;
};

/**
 * The conversation the session carries on with: the handoff first, then every
 * user turn that still has the engine's handle.
 *
 * The handle is the whole point. A message handed back with it is the engine's
 * own and stands whole; one without is rebuilt from `role`, `text` and its tool
 * blocks. So the user's words go back untouched and only the connective tissue
 * is something a model wrote.
 */
export const replacementFor = (messages, handoff) => [
    { role: "assistant", text: handoff, toolUses: [] },
    ...messages.filter(isPinnable),
];

/* ------------------------------------------------------------------ *
 * The size guard.
 * ------------------------------------------------------------------ */

/**
 * Keep the replacement small enough that the engine does not compact it again.
 *
 * A handoff plus every pinned user turn is not bounded by anything. One pasted
 * 30k-character blob is a normal thing for a person to do and several of them
 * is a normal week, so the replacement can plausibly come back larger than the
 * conversation it replaced, and the engine's answer to that is to compact
 * immediately: a second summary, of a summary, and the real user turns gone.
 *
 * The largest pinned turns are replaced with a pointer at the stored copy until
 * the whole thing fits. **The summary is never trimmed** — it is the part that
 * scored 67.3% on its own, and a session that has lost it has lost everything
 * the compaction was for. If the summary alone is over the ceiling the guard
 * gives up and says so rather than cutting into it.
 */
export const applySizeGuard = (messages, { maxChars, pointerFor }) => {
    const charsOf = (list) => list.reduce((total, message) => total + (message.text ?? "").length, 0);
    const charsBefore = charsOf(messages);

    if (charsBefore <= maxChars) {
        return { messages, trimmedTurns: 0, charsBefore, charsAfter: charsBefore, overCeiling: false };
    }

    // Index 0 is the summary and is not a candidate at any size.
    const order = messages
        .map((message, index) => ({ index, length: (message.text ?? "").length }))
        .slice(1)
        .sort((left, right) => right.length - left.length);

    const out = [...messages];
    let trimmedTurns = 0;
    let charsAfter = charsBefore;

    for (const { index, length } of order) {
        if (charsAfter <= maxChars) {
            break;
        }

        const pointer = pointerFor({ index, chars: length });

        // A pointer longer than what it replaces would make things worse.
        if (pointer.length >= length) {
            continue;
        }

        out[index] = { ...out[index], text: pointer, handle: undefined };
        charsAfter = charsAfter - length + pointer.length;
        trimmedTurns += 1;
    }

    return { messages: out, trimmedTurns, charsBefore, charsAfter, overCeiling: charsAfter > maxChars };
};

/* ------------------------------------------------------------------ *
 * Lineage: how a second compaction knows about the first.
 * ------------------------------------------------------------------ */

/**
 * The machine-readable first line every handoff carries.
 *
 * Without it the second compaction sees the first one's handoff as ordinary
 * assistant prose and re-summarises it, which is how a tool ledger erodes into
 * "the session ran some commands" over three compactions. With it the ledger
 * rows are merged from the stored JSON instead of being re-read from English.
 */
export const lineageLine = ({ session, n, prev }) =>
    `<!-- compact-handoff: session=${session} n=${n} prev=${prev ?? "none"} -->`;

export const LINEAGE_SHAPE = /<!--\s*compact-handoff:\s*session=(\S+)\s+n=(\d+)\s+prev=(\d+|none)\s*-->/u;

/** The lineage a piece of text carries, or null if it carries none. */
export const lineageOf = (text) => {
    const match = LINEAGE_SHAPE.exec(text ?? "");

    if (match === null) {
        return null;
    }

    const [, session, n, prev] = match;

    return { session, n: Number(n), prev: prev === "none" ? null : Number(prev) };
};

/** The most recent handoff already sitting in the conversation, if any. */
export const priorHandoffIn = (messages) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const lineage = lineageOf(messages[index].text);

        if (lineage !== null) {
            return { index, lineage };
        }
    }

    return null;
};

/* ------------------------------------------------------------------ *
 * The tool ledger.
 * ------------------------------------------------------------------ */

/**
 * Every tool call the session made, what it was aimed at, and what the
 * transcript says came back. Never an exit code: there isn't one.
 */
export const ledgerRows = (messages) => {
    const rows = [];

    for (const message of messages) {
        for (const use of message.toolUses ?? []) {
            const { outcome, detail } = outcomeOf(use);

            rows.push({ name: nameOf(use), target: targetOf(use), outcome, detail });
        }
    }

    return rows;
};

/**
 * The ledger as the next session reads it, this compaction's rows first and
 * every earlier compaction's rows merged in under their own heading.
 *
 * `earlier` is `[{ n, at, rows }]`, read out of the stored JSON of previous
 * compactions rather than out of their prose, so a third compaction still knows
 * the exact command the first one ran.
 */
export const renderLedger = (rows, earlier = []) => {
    if (rows.length === 0 && earlier.length === 0) {
        return "";
    }

    const out = ["## Tool ledger", ""];

    if (rows.length === 0) {
        out.push("No tool calls since the last compaction.", "");
    } else {
        out.push(...ledgerBody(rows));
    }

    for (const pass of earlier) {
        out.push(`### Before compaction ${pass.n}${pass.at === undefined ? "" : ` (${pass.at})`}`, "");

        if ((pass.rows ?? []).length === 0) {
            out.push("No tool calls recorded.", "");
            continue;
        }

        out.push(...ledgerBody(pass.rows, 4));
    }

    return out.join("\n").trimEnd();
};

/** The three subsections a set of rows renders to, at the given heading depth. */
const ledgerBody = (rows, depth = 3) => {
    const hash = "#".repeat(depth);
    const written = rows.filter((row) => ["Write", "Edit", "NotebookEdit"].includes(row.name));
    const shells = rows.filter((row) => row.name === "Bash");
    const failed = rows.filter((row) => row.outcome !== "ok" && row.outcome !== "no result in transcript");

    const out = [
        `${count(rows.length, "tool call")}: ${count(written.length, "file write")}, ${count(shells.length, "shell command")}.`,
        "Read off the transcript rather than recalled. **The transcript stores no exit",
        "code**, so the outcome of a command is what its output supports and no more.",
        "",
    ];

    if (written.length > 0) {
        out.push(`${hash} Files written (${count(written.length, "call")})`, "");
        out.push(...unique(written.map((row) => `- ${row.name} \`${row.target}\``)));
        out.push("");
    }

    if (failed.length > 0) {
        out.push(`${hash} Output that reads as a failure (${failed.length})`, "");

        for (const row of failed) {
            out.push(`- \`${row.target}\``);
            out.push(`  - ${row.outcome}${row.detail === "" ? "" : `: ${row.detail}`}`);
        }

        out.push("");
    }

    if (shells.length > 0) {
        out.push(`${hash} Every shell command, in order (${shells.length})`, "");
        out.push(...shells.map((row) => `- \`${row.target}\`${row.outcome === "ok" ? "" : ` — ${row.outcome}`}`));
        out.push("");
    }

    return out;
};

/** What the record supports about how a call ended, and nothing beyond it. */
export const outcomeOf = (use) => {
    if (use.isError === true) {
        return { outcome: "errored", detail: clipTo(firstLine(use.text ?? ""), LEDGER_ERROR_CHARS) };
    }

    if (typeof use.text !== "string" || use.text === "") {
        return { outcome: "no result in transcript", detail: "" };
    }

    const shaped = ERROR_SHAPE.exec(use.text.slice(0, ERROR_SCAN_CHARS));

    if (shaped === null) {
        return { outcome: "ok", detail: "" };
    }

    return { outcome: "unflagged, output reads as an error", detail: clipTo(shaped[0].trim(), LEDGER_ERROR_CHARS) };
};

/**
 * Which tool was called, under whichever key this build spells it.
 *
 * `types/claude-code.d.ts` out of build 2.1.269 declares `ToolUseSummary` as
 * `{id, name, input}` plus `{result, text, isError}`. Build 2.1.270 hands a hook
 * `{tool_use_id, tool, input, result, text}` instead, so reading `use.name`
 * alone yields undefined for every call. That is not hypothetical: the first
 * live compaction rendered "2 tool calls: 0 file writes, 0 shell commands" over
 * two Bash calls, and dropped the one that succeeded, because every row fell
 * through to the placeholder. Read both, and let the declared name win if a
 * later build restores it.
 */
export const nameOf = (use) => use.name ?? use.tool ?? "?";

/** What a call was aimed at, from whichever of its arguments names a target. */
export const targetOf = (use) => {
    const input = use.input ?? {};

    for (const key of LEDGER_KEYS) {
        const value = input[key];

        if (typeof value === "string" && value.trim() !== "") {
            return clipTo(value.replace(/\n/gu, " ; ").trim(), LEDGER_ARG_CHARS);
        }
    }

    return "";
};

/* ------------------------------------------------------------------ *
 * The commitments pass: what goes in, and what comes back out.
 * ------------------------------------------------------------------ */

/**
 * The assistant's own words, thinking included, newest kept when space is short.
 *
 * The last turns before a conversation ends carry the most unkept commitments,
 * because they had the least time to be acted on, so the prompt is trimmed from
 * the front and the trim is stated in it rather than hidden.
 */
export const assistantTurns = (messages) => {
    const turns = [];

    messages.forEach((message, index) => {
        if (message.role !== "assistant" || (message.text ?? "").trim() === "") {
            return;
        }

        turns.push(`===== turn ${index} =====\n${clipTo(message.text.trim(), COMMITMENT_TURN_CHARS)}`);
    });

    let kept = turns;
    let size = kept.join("\n\n").length;

    while (size > COMMITMENT_PROMPT_CHARS && kept.length > 1) {
        kept = kept.slice(1);
        size = kept.join("\n\n").length;
    }

    if (kept.length < turns.length) {
        kept = [`===== ${turns.length - kept.length} earlier turns omitted for length =====`, ...kept];
    }

    return kept.join("\n\n");
};

/** What was actually run, one line each. No results: the absence is the point. */
export const toolIndex = (messages) => {
    const rows = [];

    messages.forEach((message, index) => {
        for (const use of message.toolUses ?? []) {
            rows.push(`T${index} | ${nameOf(use)} | ${targetOf(use)}`);
        }
    });

    return rows.join("\n");
};

/** The rows the pass emitted, in the order it emitted them. */
export const commitmentsFrom = (reply) => {
    const found = [];

    for (const line of (reply ?? "").split("\n")) {
        const match = COMMITMENT_ROW.exec(line);

        if (match === null) {
            continue;
        }

        const [, kind, turn, quote, note] = match;

        found.push({
            kind: kind.toLowerCase(),
            turn: Number(turn),
            quote: quote.trim().replace(/^"|"$/gu, "").trim(),
            note: note.trim(),
        });
    }

    return found.filter((row) => row.quote.toLowerCase() !== "none");
};

export const renderCommitments = (findings) => {
    if (findings.length === 0) {
        return "";
    }

    const out = [
        "## Commitments and open questions",
        "",
        "Written by one model pass over the assistant's own turns and an index of what",
        "it ran. Unlike the two sections above this is a judgement rather than a",
        "reading: each item claims something was promised and that no evidence of it",
        "appears later, which is an absence and cannot be proved from a conversation",
        "that was cut off mid-flight. Check before acting, and do not re-do work.",
        "",
    ];

    for (const kind of ["unkept", "corrected", "unanswered"]) {
        const rows = findings.filter((row) => row.kind === kind);

        if (rows.length === 0) {
            continue;
        }

        out.push(`### ${COMMITMENT_HEADING[kind]} (${rows.length})`, "");

        for (const row of rows) {
            out.push(`- "${row.quote}"`);
            out.push(`  - ${row.note}`);
        }

        out.push("");
    }

    return out.join("\n").trimEnd();
};

/* ------------------------------------------------------------------ *
 * What a compaction costs.
 * ------------------------------------------------------------------ */

/**
 * List prices per million tokens, read off
 * https://platform.claude.com/docs/en/about-claude/pricing on 2026-09-14.
 * `cacheWrite` is the 5-minute tier, which is what a fork and a `claude -p`
 * pass actually use.
 *
 * **Matched most specific first, and a family name is never enough.** Sonnet 5
 * is $2/$10 and Sonnet 4.6 is $3/$15; Opus 5 is $5/$25 and the retired Opus 4.1
 * is $15/$75. A table keyed on the word "sonnet" would have overstated every
 * compaction on this box by 50%, and the first draft of this file did exactly
 * that from memory. The numbers below were read off the page, not recalled.
 *
 * A row whose model matches nothing records `cost: null` with a reason.
 * Pricing a token at zero because the table is stale is worse than admitting
 * the number is unknown: one is a gap, the other is a wrong number in a
 * document the operator is going to compare against their bill.
 */
/*
 * Dollars per million tokens, read on 2026-09-14 from the "Model pricing" table at
 * https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Every row below was read off that table, not recalled: all four numbers for all
 * seven rows were checked against it on 2026-09-14. Nothing here is from memory.
 * `cacheWrite` is the 5-minute write column, which is what a fork and a
 * `claude -p` actually pay; the 1-hour column is not modelled because nothing
 * here asks for a 1-hour cache.
 *
 * The Fable/Mythos split is not cosmetic. Cache hits are 0.1x base input on every
 * model EXCEPT Fable 5.1 and Mythos 5.1, which the page prices at 0.025x, so one
 * pattern over both generations under-charged a Fable 5 or Mythos 5 cache read by
 * four times. The specific row has to come first; `priceRowFor` takes the first
 * match.
 *
 * A wrong number here is silent: it mis-states every cost row and the row still
 * looks like a measurement. Re-read the page before changing PRICES_TAKEN, and
 * change them together.
 */
export const PRICES_TAKEN = "2026-09-14";

export const PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

export const PRICES = [
    { match: /fable-5-1|mythos-5-1|fable5-1|mythos5-1/u, name: "Fable/Mythos 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    { match: /fable|mythos/u, name: "Fable/Mythos 5", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    { match: /opus-4-1|opus-4(?!\d)/u, name: "Opus 4.1", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    { match: /opus/u, name: "Opus 5 / 4.5-4.8", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    { match: /sonnet-5|sonnet5/u, name: "Sonnet 5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    { match: /sonnet/u, name: "Sonnet 4.6 and earlier", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { match: /haiku-3|haiku3/u, name: "Haiku 3.5", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    { match: /haiku/u, name: "Haiku 4.5", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

/** Which price row a model id falls under, or null if the table cannot say. */
export const priceRowFor = (model) => {
    const id = (model ?? "").toLowerCase();

    if (id === "") {
        return null;
    }

    return PRICES.find((row) => row.match.test(id)) ?? null;
};

/** The four token counts a usage record carries, under either spelling. */
export const usageOf = (usage) => {
    if (usage === null || usage === undefined || typeof usage !== "object") {
        return null;
    }

    const pick = (...keys) => {
        for (const key of keys) {
            if (typeof usage[key] === "number") {
                return usage[key];
            }
        }

        return 0;
    };

    return {
        input: pick("input_tokens", "inputTokens"),
        output: pick("output_tokens", "outputTokens"),
        cacheRead: pick("cache_read_input_tokens", "cacheReadInputTokens"),
        cacheWrite: pick("cache_creation_input_tokens", "cacheCreationInputTokens"),
    };
};

/**
 * What a fork's usage cost, or null with the reason it cannot be said.
 *
 * Never 0 for an unknown. A zero here would be summed into a per-day total and
 * read as "this compaction was free".
 */
export const priceUsage = (usage, model) => {
    const tokens = usageOf(usage);

    if (tokens === null) {
        return { usd: null, reason: "no usage on the result" };
    }

    const price = priceRowFor(model);

    if (price === null) {
        return { usd: null, reason: `no price for model ${model ?? "(unset)"}`, tokens };
    }

    const usd =
        (tokens.input * price.input +
            tokens.output * price.output +
            tokens.cacheRead * price.cacheRead +
            tokens.cacheWrite * price.cacheWrite) /
        1_000_000;

    return { usd, reason: null, tokens, priced: price.name };
};

/** The whole cost of one compaction, with every part it is made of. */
export const costOf = ({ forkUsage, forkModel, commitmentsUsd }) => {
    const fork = priceUsage(forkUsage, forkModel);

    if (fork.usd === null) {
        return {
            cost: null,
            costUnknownReason: fork.reason,
        };
    }

    const commitments = typeof commitmentsUsd === "number" ? commitmentsUsd : 0;

    return {
        cost: {
            forkUsd: round6(fork.usd),
            commitmentsUsd: round6(commitments),
            totalUsd: round6(fork.usd + commitments),
            forkUsage: fork.tokens,
            model: forkModel ?? null,
            priced: fork.priced,
            pricesTaken: PRICES_TAKEN,
        },
        costUnknownReason: null,
    };
};

/**
 * A run that made no model call still has a cost, and that cost is zero.
 *
 * Distinct from an unpriceable run, which records `null` and a reason. A
 * subagent pass-through and a run refused over budget both spend nothing and
 * both know it, so summing a session's rows must not have to guess which.
 */
export const costOfNothing = (model, note) => ({
    cost: {
        forkUsd: 0,
        commitmentsUsd: 0,
        totalUsd: 0,
        forkUsage: null,
        model: model ?? null,
        priced: null,
        pricesTaken: PRICES_TAKEN,
    },
    costNote: note,
});

/**
 * Why a compaction ended as anything other than a replacement, in one field.
 *
 * Every part of this is already somewhere in the row, which is the problem: a
 * reader had to reassemble the reason out of `disposition`, `outcome`,
 * `detail`, `forkOutcome` and `forkDetail`, and a fallback nobody can read at a
 * glance is the silent failure this plugin exists to stop.
 */
export const fallbackReasonFor = (record, disposition) => {
    if (disposition === "replaced") {
        return null;
    }

    if (disposition === "passedThrough") {
        return "subagent: a subagent's own compaction, and COMPACT_HANDOFF_SUBAGENTS is unset";
    }

    if (disposition === "overBudget") {
        const spent = typeof record.spentUsd === "number" ? record.spentUsd.toFixed(2) : "?";
        const ceiling = typeof record.ceilingUsd === "number" ? record.ceilingUsd.toFixed(2) : "?";

        return `overBudget: $${spent} spent this session against a $${ceiling} ceiling`;
    }

    if (disposition === "rehearsed") {
        return "rehearsal: COMPACT_HANDOFF_LIVE is unset, so the engine's own compaction stands";
    }

    if (disposition === "abortedFallback") {
        return "aborted: the engine gave up on the dispatch before the handoff was ready";
    }

    const outcome = record.outcome || "unknown";
    const detail = typeof record.detail === "string" && record.detail !== "" ? `: ${record.detail}` : "";
    const fork =
        typeof record.forkOutcome === "string" && record.forkOutcome !== ""
            ? ` (fork ${record.forkOutcome}${record.forkDetail ? `: ${record.forkDetail}` : ""})`
            : "";

    return `${outcome}${detail}${fork}`;
};

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/* ------------------------------------------------------------------ *
 * Small shared helpers.
 * ------------------------------------------------------------------ */

/** The open PRs, with the one on this branch called out. */
export const summarisePrs = (json, branch) => {
    let prs = [];

    try {
        prs = JSON.parse(json);
    } catch {
        return null;
    }

    if (!Array.isArray(prs) || prs.length === 0) {
        return "none open";
    }

    return prs
        .map((pr) => `#${pr.number}${pr.headRefName === branch ? " (this branch)" : ""}`)
        .join(", ");
};

export const clipTo = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}[...]`);

export const firstLine = (text) => (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();

export const unique = (items) => [...new Set(items)];

/** "1 file write", "3 file writes". */
export const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The headings `handoff_lookup` reads one part of a stored handoff by. */
export const HANDOFF_SECTIONS = {
    ledger: "## Tool ledger",
    state: "## Session state",
    commitments: "## Commitments",
};

/** One `##` section of a handoff, heading included, or null when it has none. */
export const sectionOf = (text, name) => {
    const heading = HANDOFF_SECTIONS[name];

    if (heading === undefined) {
        return null;
    }

    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith(heading));

    if (start === -1) {
        return null;
    }

    const next = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));

    return lines
        .slice(start, next === -1 ? undefined : start + 1 + next)
        .join("\n")
        .trimEnd();
};

/* ------------------------------------------------------------------ *
 * What the session does with the handoff, watched for ten turns.
 * ------------------------------------------------------------------ */

/** How many turns after a compaction are watched before the file is written. */
export const POST_TURNS = 10;

/** How much of the first post-compaction message is kept verbatim. */
export const POST_MESSAGE_CHARS = 2000;

/**
 * The work a conversation has already done: every shell command it ran, and
 * every file it read whole.
 *
 * These are the raw arguments, not the ledger's clipped rendering, because the
 * question they answer is whether a command afterwards is *byte-identical* to
 * one before. A partial read (`offset`/`limit`) is not a full read and is left
 * out: re-reading the rest of a file is not repeated work.
 */
export const workDone = (messages) => {
    const commands = [];
    const reads = [];

    for (const message of messages) {
        for (const use of message.toolUses ?? []) {
            const name = nameOf(use);
            const input = use.input ?? {};

            if (name === "Bash" && typeof input.command === "string") {
                commands.push(input.command);
            }

            if (name === "Read" && typeof input.file_path === "string" && input.offset === undefined && input.limit === undefined) {
                reads.push(input.file_path);
            }
        }
    }

    return { commands: unique(commands), reads: unique(reads) };
};

/** What a compaction hands the watcher: where the new conversation starts, and what the old one already did. */
export const monitorSeed = ({ session, n, at, from, messages }) => ({
    session,
    n,
    at,
    from,
    ...workDone(messages),
});

/**
 * What the session did with the handoff, recomputed from scratch each turn.
 *
 * Nothing here calls a model. Every line is a count or a copy: a re-run command
 * is one whose text matches a pre-compaction command exactly, a re-read is a
 * whole-file read of a file that was already read whole. Recomputing rather
 * than accumulating means a tick that is missed or runs twice says the same
 * thing.
 */
export const observePost = (monitor, messages) => {
    const compactedAgain =
        messages.length < monitor.from || (priorHandoffIn(messages)?.lineage.n ?? monitor.n) > monitor.n;
    const slice = messages.slice(monitor.from);
    const after = workDone(slice);

    let turns = 0;
    let turnsToFirstToolCall = null;
    let firstUserMessage = null;
    const handoffToolsCalled = [];

    for (const message of slice) {
        if (message.role === "user" && firstUserMessage === null && originOf(message) === "person") {
            firstUserMessage = clipTo(message.text ?? "", POST_MESSAGE_CHARS);
        }

        if (message.role !== "assistant") {
            continue;
        }

        turns += 1;

        for (const use of message.toolUses ?? []) {
            const name = nameOf(use);

            if (name.includes("handoff_")) {
                handoffToolsCalled.push(name);
            }
        }

        if (turnsToFirstToolCall === null && (message.toolUses ?? []).length > 0) {
            turnsToFirstToolCall = turns;
        }
    }

    return {
        n: monitor.n,
        at: monitor.at,
        turnsObserved: turns,
        firstUserMessage,
        turnsToFirstToolCall,
        reRunCommands: after.commands.filter((command) => monitor.commands.includes(command)),
        reReadFiles: after.reads.filter((file) => monitor.reads.includes(file)),
        handoffToolsCalled: unique(handoffToolsCalled),
        compactedAgain,
        done: compactedAgain || turns >= POST_TURNS,
    };
};
