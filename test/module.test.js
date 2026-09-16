import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PLUGIN_VERSION } from "../hooks/module.js";
import { assistantTurn, fakeApi, fakeRuntime, passThrough, userTurn } from "./fixtures.js";

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

                return { text: "A handoff.", usage: { input_tokens: 1 } };
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

    it("is not raised once the session is over its budget", async () => {
        const runtime = await seamRegistered();
        const host = seamHost({ env: { COMPACT_HANDOFF_MAX_USD_PER_SESSION: "0" } });
        const noun = await seamNoun(runtime, host.$);

        await noun.beforeCompact({ tool: SEAM_TOOL, name: "memory-handoff" });

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            const row = lastRow(host);

            assert.equal(row.disposition, "overBudget");
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
