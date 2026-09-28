import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { priceUsage } from "../hooks/lib.js";
import { PLUGIN_VERSION } from "../hooks/module.js";
import { answered, assistantTurn, fakeApi, fakeRuntime, noUsage, passThrough, userTurn } from "./fixtures.js";

// `node --check` reads module.js as a script and never sees an `await` in a
// non-async arrow; 0.2.0 shipped one and only `claude plugin validate` caught
// it. Importing the module parses it the way the runtime will.
describe("the hooks module parses as the runtime loads it", () => {
    it("imports without a syntax error", async () => {
        const mod = await import("../hooks/module.js");

        assert.equal(typeof mod.register, "function");
    });
});

const registered = async () => {
    const runtime = fakeRuntime();

    (await import("../hooks/module.js")).register(runtime.on);

    return runtime;
};

/** What the engine really sends: an answer and a duration, and no transcript. */
const turnComplete = (extra = {}) => ({
    answer: "done",
    durationMs: 1234,
    aborted: false,
    turnId: "turn-1",
    reason: "answer",
    ...extra,
});

describe("the turn.complete hook, against the input the engine really sends", () => {
    it("writes a window row from the session's own transcript", async () => {
        const runtime = await registered();
        const host = fakeApi({ messages: [userTurn("go"), assistantTurn("done")] });
        const next = passThrough();

        await runtime.dispatch("turn.complete", host.$, turnComplete(), next);

        const rows = host.rowsIn("window.jsonl");

        assert.equal(rows.length, 1);
        assert.equal(rows[0].turn, 1);
        assert.equal(rows[0].messages, 2);
        assert.equal(rows[0].phase, "fresh");
        assert.equal(rows[0].percent, 6);
        assert.deepEqual(next.calls, [turnComplete()]);
    });

    // A refusal and an abort carry the same fields, and the row is the reading
    // the watch exists for: the turn still happened and still cost a window.
    it("writes one for a refused turn too", async () => {
        const runtime = await registered();
        const host = fakeApi({ messages: [userTurn("go")] });

        await runtime.dispatch("turn.complete", host.$, turnComplete({ answer: "", reason: "refusal", refusal: "no" }));

        assert.equal(host.rowsIn("window.jsonl").length, 1);
    });

    // An unreadable transcript is a field the row does not carry, never a
    // dispatch the rest of the turn loses.
    it("still writes a row when the transcript cannot be read", async () => {
        const runtime = await registered();
        const host = fakeApi({
            session: {
                messages: async () => {
                    throw new Error("the host said no");
                },
            },
        });
        const next = passThrough();

        await runtime.dispatch("turn.complete", host.$, turnComplete(), next);

        const rows = host.rowsIn("window.jsonl");

        assert.equal(rows.length, 1);
        assert.equal(rows[0].messages, null);
        assert.equal(rows[0].handoffChars, null);
        assert.equal(next.calls.length, 1);
    });
});

describe("a compaction timed while the engine's clock answers a Promise", () => {
    it("records elapsedMs as a number, not null", async () => {
        const runtime = await registered();
        const host = fakeApi();
        const next = passThrough();

        // A subagent's compaction is passed through with a row, which is the
        // shortest path to a stored row and times itself like every other.
        await runtime.dispatch(
            "session.compact",
            host.$,
            { trigger: "manual", agentId: "agent-1", messages: [userTurn("go")], instructions: "" },
            next,
        );

        const rows = host.rowsIn("index.jsonl");

        assert.equal(rows.length, 1);
        assert.equal(rows[0].disposition, "passedThrough");
        assert.equal(typeof rows[0].elapsedMs, "number");
        assert.ok(Number.isFinite(rows[0].elapsedMs));
        assert.equal(next.calls.length, 1);
    });
});

/* ------------------------------------------------------------------ *
 * The seam another plugin subscribes through.
 * ------------------------------------------------------------------ */

/**
 * A host whose `clock.sleep` is a real timer, since the seam's cap is a race
 * against it and the fixture's default sleep resolves at once, which would time
 * every subscriber out.
 *
 * Every timer it hands out is remembered, because the loser of a `Promise.race`
 * against one keeps running: the seam's own cap, and the module's 120-second
 * commitments cap on any test whose fork answers. `stopTimers()` in a `finally`
 * is what keeps a passing test from holding the runner open for two minutes.
 */
const seamHost = (overrides = {}) => {
    const timers = new Set();
    const host = fakeApi({
        ...overrides,
        env: { COMPACT_HANDOFF_SEAM_TIMEOUT_MS: "300", ...overrides.env },
        clock: {
            sleep: (ms) =>
                new Promise((resolve) => {
                    timers.add(setTimeout(resolve, ms));
                }),
            ...overrides.clock,
        },
    });

    host.stopTimers = () => {
        for (const timer of timers) {
            clearTimeout(timer);
        }

        timers.clear();
    };

    return host;
};

/** `next` as the engine hands it to `session.compact`: carrying a signal. */
const compactNext = () => {
    const next = passThrough();

    next.signal = new AbortController().signal;

    return next;
};

const compaction = (extra = {}) => ({
    trigger: "manual",
    agentId: null,
    messages: [userTurn("go"), assistantTurn("done")],
    instructions: "",
    ...extra,
});

/** The tool the memory plugin answers, and the one every test here subscribes. */
const SEAM_TOOL = "mcp__memory-handoff__before_compact";

/**
 * The module with an empty seam.
 *
 * A subscription lives for the load and there is no unsubscribe, so a test that
 * wants a known number of subscribers clears the map the module exports for it.
 */
const seamRegistered = async () => {
    (await import("../hooks/module.js")).seamSubscribers.clear();

    return registered();
};

/** The seam's noun, taken the way the engine takes it: through the fold. */
const seamNoun = async (runtime, $) => {
    const built = await runtime.dispatch("engine.create", {}, { plugins: ["compact-handoff"] }, async () => $);

    return built.compactHandoff;
};

/** A promise that fails rather than hangs, so a serial seam is a red test. */
const withDeadline = (promise, what) =>
    Promise.race([
        promise,
        new Promise((_resolve, reject) => void setTimeout(() => reject(new Error(`${what} never happened`)), 1000)),
    ]);

/** The last row this host wrote, which is the compaction the test just ran. */
const lastRow = (host) => host.rowsIn("index.jsonl").at(-1);

/** Every raise of the seam's tool, with the restore reads left out. */
const seamRaises = (host) => host.toolCalls.filter((input) => input.tool === SEAM_TOOL);

describe("the engine.create fold that adds $.compactHandoff", () => {
    it("adds the noun without dropping what the steps beneath built", async () => {
        const runtime = await seamRegistered();
        const host = seamHost();
        const built = await runtime.dispatch("engine.create", {}, { plugins: ["compact-handoff"] }, async () => host.$);

        assert.equal(typeof built.compactHandoff.beforeCompact, "function");
        assert.equal(typeof built.compactHandoff.version, "function");
        assert.equal(await built.compactHandoff.version(), PLUGIN_VERSION);
        assert.equal(typeof built.session.id, "function");
    });

    // The fold may not pass `built` to a function, so the version cannot be
    // read off the manifest there and is a constant instead. This is the only
    // thing keeping the constant and the manifest from drifting apart.
    it("answers the version the manifest declares", () => {
        const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));

        assert.equal(PLUGIN_VERSION, manifest.version);
    });
});

describe("subscribing to the seam", () => {
    it("takes the tool to raise and answers that it is subscribed", async () => {
        const runtime = await seamRegistered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);

        assert.deepEqual(await noun.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" }), {
            subscribed: true,
            tool: SEAM_TOOL,
        });
    });

    it("refuses a subscription that names no tool", async () => {
        const runtime = await seamRegistered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);

        await assert.rejects(() => noun.beforeCompact({ name: "memory-handoff" }), TypeError);
        await assert.rejects(() => noun.beforeCompact({ tool: "   " }), TypeError);
    });

    // A plugin reloaded mid-session runs `session.start` again, and a second
    // subscription for one tool would raise it twice for one compaction.
    it("is idempotent per tool, so a reload subscribes once", async () => {
        const runtime = await seamRegistered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);

        await noun.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });
        await noun.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            assert.equal(lastRow(host).seam.subscribers, 1);
            assert.equal(seamRaises(host).length, 1);
        } finally {
            host.stopTimers();
        }
    });
});

describe("a compaction with nobody subscribed to the seam", () => {
    it("records seam: { subscribers: 0 } and raises nothing", async () => {
        const runtime = await seamRegistered();
        const host = seamHost();

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            assert.deepEqual(lastRow(host).seam, { subscribers: 0 });
            assert.equal(seamRaises(host).length, 0);
        } finally {
            host.stopTimers();
        }
    });
});

describe("a subscriber on the seam", () => {
    it("has its tool raised with the trigger and the message count, and nothing else", async () => {
        const runtime = await seamRegistered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);

        await noun.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            // Three small values and no transcript: an interface call clones
            // its arguments, and the subscriber reads the conversation with a
            // fork of the same session rather than a copy of it.
            assert.deepEqual(seamRaises(host), [
                { tool: SEAM_TOOL, trigger: "manual", messageCount: 2 },
            ]);

            const row = lastRow(host);

            assert.equal(row.seam.subscribers, 1);
            assert.equal(row.seam.results.length, 1);
            assert.equal(row.seam.results[0].name, "memory-handoff");
            assert.equal(row.seam.results[0].tool, SEAM_TOOL);
            assert.equal(row.seam.results[0].outcome, "ok");
            assert.equal(typeof row.seam.results[0].elapsedMs, "number");
        } finally {
            host.stopTimers();
        }
    });

    it("is named after its tool when it did not name itself", async () => {
        const runtime = await seamRegistered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);

        await noun.beforeCompact({ tool: SEAM_TOOL });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            assert.equal(lastRow(host).seam.results[0].name, SEAM_TOOL);
        } finally {
            host.stopTimers();
        }
    });

    // A hook that refuses the raise answers `{ deny }`, which is a legitimate
    // answer and not an error, so the row says which of the two it was.
    it("records a refused raise as denied, with the reason", async () => {
        const runtime = await seamRegistered();
        const host = seamHost({ toolCall: async () => ({ deny: "not this session" }) });
        const noun = await seamNoun(runtime, host.$);

        await noun.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            const result = lastRow(host).seam.results[0];

            assert.equal(result.outcome, "denied");
            assert.equal(result.detail, "not this session");
        } finally {
            host.stopTimers();
        }
    });

    // Each side waits for the other to have started, so a seam that ran before
    // the fork or after it deadlocks and the deadline turns that into a
    // failure. Nothing here depends on which of the two goes first.
    it("runs beside the fork rather than before or after it", async () => {
        const runtime = await seamRegistered();
        let forkStarted = () => {};
        let seamStarted = () => {};
        const forkIsRunning = new Promise((resolve) => (forkStarted = resolve));
        const seamIsRunning = new Promise((resolve) => (seamStarted = resolve));
        let forkSawTheSeam = false;
        let seamSawTheFork = false;
        const host = seamHost({
            toolCall: async (input) => {
                if (input.tool !== SEAM_TOOL) {
                    return { result: "answered" };
                }

                seamStarted();
                await withDeadline(forkIsRunning, "the fork");
                seamSawTheFork = true;

                return { result: { outcome: "extracted" } };
            },
        });

        host.$.model = {
            fork: async () => {
                forkStarted();
                await withDeadline(seamIsRunning, "the seam");
                forkSawTheSeam = true;

                return answered("A handoff.", { input_tokens: 1 });
            },
        };

        const noun = await seamNoun(runtime, host.$);

        await noun.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            assert.equal(forkSawTheSeam, true);
            assert.equal(seamSawTheFork, true);
            assert.equal(lastRow(host).seam.results[0].outcome, "ok");
        } finally {
            host.stopTimers();
        }
    });

    it("is abandoned once it runs past the cap, and the compaction goes on", async () => {
        const runtime = await seamRegistered();
        const host = seamHost({
            env: { COMPACT_HANDOFF_SEAM_TIMEOUT_MS: "20" },
            toolCall: () => new Promise(() => {}),
        });
        const noun = await seamNoun(runtime, host.$);
        const next = compactNext();

        await noun.beforeCompact({ tool: SEAM_TOOL, name: "slow" });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), next);

            const row = lastRow(host);

            assert.deepEqual(
                row.seam.results.map((result) => result.outcome),
                ["timedOut"],
            );
            assert.equal(typeof row.seam.results[0].elapsedMs, "number");
            assert.equal(next.calls.length, 1);
        } finally {
            host.stopTimers();
        }
    });

    it("cannot change what this plugin does by throwing", async () => {
        const runtime = await seamRegistered();
        const alone = seamHost();

        await runtime.dispatch("session.compact", alone.$, compaction(), compactNext());

        const control = lastRow(alone);

        alone.stopTimers();

        const host = seamHost({
            toolCall: () => {
                throw new Error("the raise broke");
            },
        });
        const noun = await seamNoun(runtime, host.$);
        const next = compactNext();

        await noun.beforeCompact({ tool: SEAM_TOOL, name: "broken" });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), next);

            const row = lastRow(host);

            assert.equal(row.seam.results[0].outcome, "threw");
            assert.match(row.seam.results[0].detail, /the raise broke/u);
            assert.equal(row.outcome, control.outcome);
            assert.equal(row.disposition, control.disposition);
            assert.equal(next.calls.length, 1);
        } finally {
            host.stopTimers();
        }
    });

    it("is not raised on a compaction this plugin only passes through", async () => {
        const runtime = await seamRegistered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);

        await noun.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });

        try {
            await runtime.dispatch("session.compact", host.$, compaction({ agentId: "agent-1" }), compactNext());

            const row = lastRow(host);

            assert.equal(row.disposition, "passedThrough");
            assert.equal(row.seam, undefined);
            assert.equal(seamRaises(host).length, 0);
        } finally {
            host.stopTimers();
        }
    });
});

/* ------------------------------------------------------------------ *
 * The spellings the engine's static scan refuses at load.
 *
 * Every rule here was read off the scan's own messages in
 * `pretty-v2.1.273.js:223139-223260`, and two of them refused 0.5.0 outright in
 * a live run. A grep is a poor parser and will not catch every spelling, but it
 * catches the four that have actually cost a load.
 * ------------------------------------------------------------------ */

const moduleSource = readFileSync(new URL("../hooks/module.js", import.meta.url), "utf8");

describe("the module is spelled the way the engine's static scan demands", () => {
    // "$.<noun> is used as a value": an optional chain READS the noun before
    // deciding to call it, so `$.compactHandoff?.beforeCompact(...)` is refused
    // even though the call is right there.
    it("never optionally chains a noun of $", () => {
        assert.equal(/\$\.[A-Za-z_$][\w$]*\?\./u.test(moduleSource), false);
    });

    // Same message. `$` is spelled `$.noun.event(...)` at the call site, so a
    // computed noun (`$[name].event()`) is refused: the scan cannot read it.
    it("never reaches a noun of $ by computed key", () => {
        assert.equal(/\$\[/u.test(moduleSource), false);
    });

    // Same message again, the plainest form: a noun bound, passed or returned
    // rather than called. `const t = $.tool;` and `f($.tool)` both end in a
    // noun followed by one of `;`, `,` or `)`.
    it("never binds, passes or returns a noun of $ as a value", () => {
        assert.equal(/\$\.[A-Za-z_$][\w$]*\s*[;,)]/u.test(moduleSource), false);
    });

    // "the value of next(e) at engine.create is passed as an argument": the
    // fold may const-bind `built`, spread it into an object literal or return
    // it. `pluginVersion(built)` is the line that refused 0.5.0 at load.
    it("never passes the value of next(e) at engine.create to a function", () => {
        assert.equal(/[\w.]+\(\s*built\s*[,)]/u.test(moduleSource), false);
    });
});

/**
 * Issue #690: some forks come back having read a transcript that is not this
 * conversation, and the reply reads like any other summary. The only thing on
 * the row that can tell is what the fork was charged for.
 */
describe("a fork charged for a fraction of the session's context", () => {
    const coldUsage = {
        input_tokens: 46_387,
        output_tokens: 9909,
        cache_read_input_tokens: 18_705,
        cache_creation_input_tokens: 0,
    };

    /** A live session holding 164k tokens, with a handoff already on disk. */
    const forkingHost = (usage) =>
        fakeApi({
            env: { COMPACT_HANDOFF_LIVE: "1" },
            files: { "/plugin/.runs/latest.md": "THE HANDOFF ON DISK" },
            messages: [userTurn("go"), assistantTurn("done")],
            model: { fork: async () => answered("A SUMMARY OF SOME OTHER CONVERSATION", usage) },
            session: { usage: async () => ({ context: { tokens: 164_273, window: 200_000, percent: 82 } }) },
        });

    const compaction = () => ({
        trigger: "auto",
        agentId: null,
        messages: [userTurn("go"), assistantTurn("done")],
        instructions: "",
    });

    it("is recorded as a mismatch and falls back to the handoff on disk", async () => {
        const runtime = await registered();
        const host = forkingHost(coldUsage);

        host.store.set("ready", { messages: 2, at: new Date().toISOString() });

        const answer = await runtime.dispatch("session.compact", host.$, compaction(), passThrough());
        const row = host.rowsIn("index.jsonl").at(-1);

        assert.equal(row.forkOutcome, "mismatch");
        assert.equal(row.forkInput.sent, 65_092);
        assert.equal(row.forkInput.contextTokens, 164_273);
        assert.equal(row.forkInput.matchesContext, false);
        assert.equal(row.outcome, "handoff");
        // The tokens were spent whether or not the answer was used.
        assert.equal(row.usage.input_tokens, 46_387);

        const replaced = JSON.stringify(answer.messages);

        assert.ok(replaced.includes("THE HANDOFF ON DISK"), "the on-disk handoff replaced the conversation");
        assert.ok(!replaced.includes("SOME OTHER CONVERSATION"), "the cold fork's answer is not handed up");
    });

    it("hands up a fork that did read this conversation, and says what it read", async () => {
        const runtime = await registered();
        const warm = {
            input_tokens: 2291,
            output_tokens: 1894,
            cache_read_input_tokens: 165_000,
            cache_creation_input_tokens: 0,
        };
        const host = forkingHost(warm);

        const answer = await runtime.dispatch("session.compact", host.$, compaction(), passThrough());
        const row = host.rowsIn("index.jsonl").at(-1);

        assert.equal(row.forkOutcome, undefined);
        assert.equal(row.outcome, "handoff");
        assert.equal(row.forkInput.matchesContext, true);
        assert.ok(JSON.stringify(answer.messages).includes("SOME OTHER CONVERSATION"));
    });

    it("carries the reading on a row that never forked at all", async () => {
        const runtime = await registered();
        const host = fakeApi();

        await runtime.dispatch(
            "session.compact",
            host.$,
            { trigger: "manual", agentId: "agent-1", messages: [userTurn("go")], instructions: "" },
            passThrough(),
        );

        assert.equal(host.rowsIn("index.jsonl").at(-1).forkInput, null);
    });
});

/* ------------------------------------------------------------------ *
 * The model calls, read as the result unions engine 2.1.280 resolves.
 * ------------------------------------------------------------------ */

/** A fork that read this conversation: charged for at least the 12k context the fixture reports. */
const warmForkUsage = {
    input_tokens: 10,
    output_tokens: 400,
    cache_read_input_tokens: 12_000,
    cache_creation_input_tokens: 0,
};

/**
 * The commitments pass has to see its reply, or the handoff ships without the
 * one section a reading cannot produce. A string check read every result object
 * as an empty reply, so the section vanished and nothing on the row said why.
 */
describe("the commitments pass, read as the result the engine resolves", () => {
    const COMMITMENT = "UNKEPT | T2 | I will rerun the gate | no later run appears";

    /** A live session whose fork answers, so the assembled handoff is handed up. */
    const committingHost = (complete) =>
        seamHost({
            env: { COMPACT_HANDOFF_LIVE: "1" },
            messages: [userTurn("go"), assistantTurn("I will rerun the gate.")],
            model: { fork: async () => answered("THE FORK'S SUMMARY", warmForkUsage), complete },
        });

    it("carries an answered reply's commitments into the handoff, priced from the reply's own usage", async () => {
        const runtime = await seamRegistered();
        const passUsage = {
            input_tokens: 1_000_000,
            output_tokens: 1000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        };
        const host = committingHost(async () => answered(COMMITMENT, passUsage));

        try {
            const answer = await runtime.dispatch("session.compact", host.$, compaction(), compactNext());
            const parts = lastRow(host).parts;
            const handedUp = JSON.stringify(answer.messages);

            assert.ok(handedUp.includes("I will rerun the gate"), "the commitment reached the handoff");
            assert.equal(parts.commitmentsReplyChars, COMMITMENT.length);
            assert.equal(parts.commitmentsRows, 1);
            // A million input tokens is what the API counted; four characters a
            // token over this prompt would price a few thousand.
            assert.equal(parts.commitmentsCostUsd, priceUsage(passUsage, parts.commitmentsModel).usd);
            assert.match(parts.commitmentsCostBasis, /^measured/u);
        } finally {
            host.stopTimers();
        }
    });

    it("hands the handoff up without the section when the pass went unanswered, and says why", async () => {
        const runtime = await seamRegistered();
        const host = committingHost(async () => ({
            isAnswered: false,
            reason: "api-error",
            status: 529,
            error: "overloaded",
            usage: noUsage(),
        }));

        try {
            const answer = await runtime.dispatch("session.compact", host.$, compaction(), compactNext());
            const row = lastRow(host);
            const handedUp = JSON.stringify(answer.messages);

            assert.equal(row.disposition, "replaced");
            assert.ok(handedUp.includes("THE FORK'S SUMMARY"));
            assert.ok(!handedUp.includes("Commitments and open questions"));
            assert.equal(row.parts.commitmentsReplyChars, 0);
            assert.equal(row.parts.commitmentsUnanswered, "api-error");
            assert.equal(row.parts.commitmentsStatus, 529);
        } finally {
            host.stopTimers();
        }
    });
});

/**
 * A fork resolves a named reason when it has no reply, never null. Each one is
 * a fallback to the handoff on disk that the row names, and never a TypeError
 * the row can only call `threw`.
 */
describe("a fork the engine left unanswered", () => {
    const spent = { input_tokens: 90_000, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const arms = [
        { isAnswered: false, reason: "nothing-to-fork" },
        { isAnswered: false, reason: "api-error", status: 500, error: "server_error", usage: noUsage() },
        { isAnswered: false, reason: "empty-reply", usage: spent },
        { isAnswered: false, reason: "aborted", usage: noUsage() },
    ];

    for (const arm of arms) {
        it(`records ${arm.reason} and falls back to the handoff on disk`, async () => {
            const runtime = await registered();
            const host = fakeApi({
                env: { COMPACT_HANDOFF_LIVE: "1" },
                files: { "/plugin/.runs/latest.md": "THE HANDOFF ON DISK" },
                messages: [userTurn("go"), assistantTurn("done")],
                model: { fork: async () => arm },
            });

            host.store.set("ready", { messages: 2, at: new Date().toISOString() });

            const answer = await runtime.dispatch("session.compact", host.$, compaction(), passThrough());
            const row = lastRow(host);

            assert.equal(row.forkOutcome, arm.reason);
            assert.equal(row.outcome, "handoff");
            assert.ok(JSON.stringify(answer.messages).includes("THE HANDOFF ON DISK"));
        });
    }

    // The request was made and paid for even though nothing came back.
    it("keeps what an unanswered fork spent on the row", async () => {
        const runtime = await registered();
        const host = fakeApi({ model: { fork: async () => arms[2] } });

        await runtime.dispatch("session.compact", host.$, compaction(), passThrough());

        assert.equal(lastRow(host).usage.input_tokens, 90_000);
    });
});

/**
 * A fork that never comes back must not hold the person's compaction for as
 * long as the request runs. Past its bound the compaction falls back to the
 * handoff on disk, and whatever the fork answers afterwards is dropped.
 */
describe("a fork that runs past its bound", () => {
    // `clock.sleep` resolves at once here, so the bound expires the moment the
    // fork is raised; the real clock is left to the fork alone.
    const fallbackHost = (fork) => {
        const host = fakeApi({
            env: { COMPACT_HANDOFF_LIVE: "1" },
            files: { "/plugin/.runs/latest.md": "THE HANDOFF ON DISK" },
            messages: [userTurn("go"), assistantTurn("done")],
            model: { fork },
        });

        host.store.set("ready", { messages: 2, at: new Date().toISOString() });

        return host;
    };

    it("falls back to the handoff on disk and records a timeout", async () => {
        const runtime = await registered();
        const host = fallbackHost(() => new Promise(() => {}));

        const answer = await withDeadline(
            runtime.dispatch("session.compact", host.$, compaction(), passThrough()),
            "the compaction",
        );
        const row = lastRow(host);

        assert.equal(row.forkOutcome, "timeout");
        assert.equal(row.outcome, "handoff");
        assert.ok(JSON.stringify(answer.messages).includes("THE HANDOFF ON DISK"));
    });

    it("drops what the fork answers after the bound", async () => {
        const runtime = await registered();
        const lateReply = answered("THE LATE FORK", warmForkUsage);
        const host = fallbackHost(() => new Promise((resolve) => void setTimeout(() => resolve(lateReply), 30)));

        const answer = await runtime.dispatch("session.compact", host.$, compaction(), passThrough());

        await new Promise((resolve) => void setTimeout(resolve, 90));

        const written = [...host.files.values(), ...host.appends.map((entry) => entry.line)].join("\n");

        assert.equal(host.rowsIn("index.jsonl").length, 1);
        assert.equal(lastRow(host).forkOutcome, "timeout");
        assert.ok(!JSON.stringify(answer.messages).includes("THE LATE FORK"));
        assert.ok(!written.includes("THE LATE FORK"), "nothing the late fork said was written");
    });
});

/* ------------------------------------------------------------------ *
 * The settings, as the engine hands them to `register`.
 * ------------------------------------------------------------------ */

const manifestSettings = () =>
    JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).userConfig;

/**
 * `register`'s options the way the engine builds them: what the person stored
 * for each declared field, else that field's declared default, and no key at
 * all for a field with neither.
 */
const engineOptions = (stored = {}) => {
    const options = {};

    for (const [key, field] of Object.entries(manifestSettings())) {
        const value = stored[key] ?? field.default;

        if (value !== undefined) {
            options[key] = value;
        }
    }

    return options;
};

/**
 * Every setting was an environment variable first, and a setting nobody touched
 * has to leave the variable in charge. A declared default the module reads as
 * set silently overrides the variable for everyone who never opened the menu.
 */
describe("a setting nobody touched leaves its environment variable in charge", () => {
    const registeredWith = async (options) => {
        const runtime = fakeRuntime();

        (await import("../hooks/module.js")).register(runtime.on, options);

        return runtime;
    };

    const dispositionOf = async (options, env) => {
        const runtime = await registeredWith(options);
        const host = seamHost({
            env,
            messages: [userTurn("go"), assistantTurn("done")],
            model: { fork: async () => answered("THE FORK'S SUMMARY", warmForkUsage) },
        });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            return lastRow(host).disposition;
        } finally {
            host.stopTimers();
        }
    };

    it("answers the compaction when live is unset and COMPACT_HANDOFF_LIVE is on", async () => {
        assert.equal(await dispositionOf(engineOptions(), { COMPACT_HANDOFF_LIVE: "1" }), "replaced");
    });

    it("rehearses when live is set off, whatever the variable says", async () => {
        assert.equal(await dispositionOf(engineOptions({ live: false }), { COMPACT_HANDOFF_LIVE: "1" }), "rehearsed");
    });

    it("answers the compaction when live is set on and no variable is", async () => {
        assert.equal(await dispositionOf(engineOptions({ live: true }), {}), "replaced");
    });

    it("declares no default the module would read as a setting", () => {
        const masking = Object.entries(manifestSettings())
            .filter(([, field]) => "default" in field && field.default !== "" && field.default !== 0)
            .map(([key]) => key);

        assert.deepEqual(masking, []);
    });
});

/**
 * A session's spend is not a reason to stop handing off. The sessions that
 * compact most are the long ones, which are the ones that most need a good
 * handoff, and a sum across compactions cut them off exactly there.
 */
describe("a session that has already spent more than $10 on handoffs", () => {
    const sessionLog = "/home/nobody/.claude/compact-handoff/sessions/session-under-test/runs.jsonl";

    /** Earlier rows summing to $13.50, the last one refused as overBudget by an older plugin. */
    const expensiveHistory = () =>
        [
            { depth: 1, disposition: "replaced", cost: { totalUsd: 4.5 } },
            { depth: 2, disposition: "replaced", cost: { totalUsd: 4.5 } },
            { depth: 3, disposition: "replaced", cost: { totalUsd: 4.5 } },
            {
                depth: 4,
                disposition: "overBudget",
                outcome: "overBudget",
                spentUsd: 13.5,
                ceilingUsd: 10,
                cost: { totalUsd: 0 },
                fallbackReason: "overBudget: $13.50 spent this session against a $10.00 ceiling",
            },
        ]
            .map((row) => JSON.stringify(row))
            .join("\n");

    it("still forks on the next compaction", async () => {
        const runtime = await registered();
        let forks = 0;
        const host = seamHost({
            files: { [sessionLog]: expensiveHistory() },
            messages: [userTurn("go"), assistantTurn("done")],
            model: {
                fork: async () => {
                    forks += 1;

                    // Read over the whole 12k-token context the fixture holds,
                    // so the answer is this conversation's and is handed up.
                    return answered("A handoff.", { input_tokens: 10, cache_read_input_tokens: 12_000 });
                },
            },
        });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            const row = lastRow(host);

            assert.equal(forks, 1);
            assert.notEqual(row.disposition, "overBudget");
            assert.equal(row.outcome, "handoff");
        } finally {
            host.stopTimers();
        }
    });

    it("reads back through handoff_status, old overBudget row and all, with no ceiling in it", async () => {
        const runtime = await registered();
        const host = fakeApi({ files: { [sessionLog]: expensiveHistory() } });

        const answer = await runtime.dispatch("tool.call", host.$, { tool: "mcp__compact-handoff__handoff_status" });
        const status = JSON.parse(answer.result);

        assert.equal(status.spentUsd, 13.5);
        assert.equal(status.last.disposition, "overBudget");
        assert.equal(status.runs.length, 4);
        assert.equal("ceilingUsd" in status, false);
    });

    it("lists the old overBudget row through handoff_list", async () => {
        const runtime = await registered();
        const host = fakeApi({ files: { [sessionLog]: expensiveHistory() } });

        const answer = await runtime.dispatch("tool.call", host.$, { tool: "mcp__compact-handoff__handoff_list" });
        const listed = JSON.parse(answer.result);

        assert.deepEqual(
            listed.map((row) => row.disposition),
            ["replaced", "replaced", "replaced", "overBudget"],
        );
    });
});

/**
 * The engine runs `$.model.fork` as a query loop over the main thread's
 * transcript plus the fork prompt, and checks that loop for auto-compaction
 * like any other. When the main thread crossed its threshold by less than the
 * prompt's size, the fork loop is over it too, so the engine dispatches a
 * second `session.compact` carrying the fork loop's `agentId` while this
 * plugin's own compaction is still waiting on the fork. Passing that one
 * through lets the engine summarise the fork loop, and the fork then answers
 * over the summary: charged for a fraction of the context, a cold fork.
 *
 * The fake fork does what the engine does: it dispatches the nested
 * compaction through the same hooks, then answers over the engine's summary
 * when it was passed through, or over the whole conversation when skipped.
 */
describe("the plugin's own fork, compacted by the engine while the compaction waits on it", () => {
    const conversation = [userTurn("go"), assistantTurn("done")];
    const context = { tokens: 67_500, window: 100_000, percent: 67 };
    const overSummary = {
        input_tokens: 21_000,
        output_tokens: 3000,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 0,
    };
    const overConversation = {
        input_tokens: 1500,
        output_tokens: 3000,
        cache_read_input_tokens: 66_000,
        cache_creation_input_tokens: 0,
    };

    /** A live session whose fork meets the nested compaction, and a subagent's beside it if asked. */
    const nestingHost = (runtime, { subagentCompacts = false } = {}) => {
        const seen = { prompt: null, own: null, subagent: null };
        const host = fakeApi({
            env: { COMPACT_HANDOFF_LIVE: "1" },
            files: { "/plugin/.runs/latest.md": "THE HANDOFF ON DISK" },
            messages: conversation,
            session: { usage: async () => ({ context }) },
            // The fork's wall-clock bound races `clock.sleep`, which the
            // fixture resolves at once; this fork awaits the nested dispatch,
            // so it has to be given a clock that never runs out.
            clock: { sleep: () => new Promise(() => {}) },
            model: {
                fork: async ({ prompt }) => {
                    seen.prompt = prompt;

                    if (subagentCompacts) {
                        seen.subagent = await runtime.dispatch(
                            "session.compact",
                            host.$,
                            {
                                trigger: "auto",
                                agentId: "agent-7",
                                messages: [userTurn("survey the repo"), assistantTurn("reading")],
                                instructions: "",
                            },
                            passThrough(),
                        );
                    }

                    seen.own = await runtime.dispatch(
                        "session.compact",
                        host.$,
                        {
                            trigger: "auto",
                            agentId: "fork-loop",
                            messages: [...conversation, userTurn(prompt)],
                            instructions: "",
                        },
                        passThrough(),
                    );

                    return seen.own?.passedThrough === true
                        ? { isAnswered: true, text: "A HANDOFF OF THE ENGINE'S SUMMARY", usage: overSummary }
                        : { isAnswered: true, text: "A HANDOFF OF THE WHOLE CONVERSATION", usage: overConversation };
                },
            },
        });

        return { host, seen };
    };

    const autoCompaction = () => ({ trigger: "auto", agentId: null, messages: conversation, instructions: "" });

    const rowOf = (host, agentId) => host.rowsIn("index.jsonl").find((row) => row.agentId === agentId);

    it("declines the fork loop's compaction, so the fork reads the whole conversation and is handed up", async () => {
        const runtime = await registered();
        const { host, seen } = nestingHost(runtime);

        const answer = await runtime.dispatch("session.compact", host.$, autoCompaction(), passThrough());
        const main = rowOf(host, null);
        const forkLoop = rowOf(host, "fork-loop");

        assert.equal(typeof seen.own?.skip, "string", "the nested compaction is declined, not passed through");
        assert.equal(forkLoop.outcome, "ownFork");
        assert.equal(forkLoop.disposition, "skipped");
        assert.equal(main.forkInput.matchesContext, true);
        assert.equal(main.forkOutcome, undefined);
        assert.equal(main.outcome, "handoff");
        assert.ok(JSON.stringify(answer.messages).includes("A HANDOFF OF THE WHOLE CONVERSATION"));
    });

    it("still passes a genuine subagent's compaction through while the fork is in flight", async () => {
        const runtime = await registered();
        const { host, seen } = nestingHost(runtime, { subagentCompacts: true });

        await runtime.dispatch("session.compact", host.$, autoCompaction(), passThrough());

        const subagent = rowOf(host, "agent-7");

        assert.equal(seen.subagent?.passedThrough, true, "the engine's own compaction ran for the subagent");
        assert.equal(subagent.outcome, "subagent");
        assert.equal(subagent.disposition, "passedThrough");
    });

    it("declines the fork loop's compaction when the person gave /compact instructions too", async () => {
        const runtime = await registered();
        const { host, seen } = nestingHost(runtime);
        const instructed = { ...autoCompaction(), trigger: "manual", instructions: "keep the migration plan" };

        await runtime.dispatch("session.compact", host.$, instructed, passThrough());

        assert.ok(seen.prompt.endsWith("keep the migration plan"), "the instructions ride on the fork prompt");
        assert.equal(typeof seen.own?.skip, "string");
        assert.equal(rowOf(host, "fork-loop").outcome, "ownFork");
    });

    it("tells the person only about the real compaction, never the declined fork loop", async () => {
        const runtime = await registered();
        const { host } = nestingHost(runtime);

        await runtime.dispatch("session.compact", host.$, autoCompaction(), passThrough());

        assert.equal(host.toasts.length, 1);
        assert.match(host.toasts[0].text, /replaced/);
    });

    it("reports the real compaction as the last one even when the fork loop is declined after it", async () => {
        const runtime = await registered();
        // The fixture's exec does not append, so the session's log is seeded
        // the way a fork loop still over the threshold leaves it.
        const runs = [
            { at: "2026-09-28T03:00:00.000Z", agentId: null, outcome: "handoff", disposition: "replaced", depth: 1 },
            { at: "2026-09-28T03:00:01.000Z", agentId: "fork-loop", outcome: "ownFork", disposition: "skipped", depth: 1 },
        ];
        const sessionLog = "/home/nobody/.claude/compact-handoff/sessions/session-under-test/runs.jsonl";
        const host = fakeApi({ files: { [sessionLog]: runs.map((row) => JSON.stringify(row)).join("\n") } });

        const answer = await runtime.dispatch("tool.call", host.$, { tool: "mcp__compact-handoff__handoff_status" });
        const status = JSON.parse(answer.result);

        assert.equal(status.last.disposition, "replaced");
    });

    it("never declines a main-thread compaction whose transcript quotes the fork prompt", async () => {
        const runtime = await registered();
        const first = nestingHost(runtime);

        await runtime.dispatch("session.compact", first.host.$, autoCompaction(), passThrough());

        const host = fakeApi();
        const next = passThrough();
        const quoted = { trigger: "manual", agentId: null, messages: [userTurn(first.seen.prompt), assistantTurn("ok")], instructions: "" };

        const answer = await runtime.dispatch("session.compact", host.$, quoted, next);

        assert.equal(typeof first.seen.prompt, "string");
        assert.notEqual(lastRow(host).outcome, "ownFork");
        assert.equal(answer?.skip, undefined);
    });
});
