import { describe, it } from "node:test";
import assert from "node:assert/strict";

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

describe("the engine.create fold that adds $.compactHandoff", () => {
    it("adds the noun without dropping what the steps beneath built", async () => {
        const runtime = await registered();
        const host = seamHost();
        const built = await runtime.dispatch("engine.create", {}, { plugins: ["compact-handoff"] }, async () => host.$);

        assert.equal(typeof built.compactHandoff.beforeCompact, "function");
        assert.equal(built.compactHandoff.version, "0.0.0-test");
        assert.equal(typeof built.session.id, "function");
    });

    it("refuses a subscriber that is not a function", async () => {
        const runtime = await registered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);

        assert.throws(() => noun.beforeCompact("not a function"), TypeError);
    });
});

describe("a compaction with nobody subscribed to the seam", () => {
    it("records seam: { subscribers: 0 } and calls nothing", async () => {
        const runtime = await registered();
        const host = seamHost();

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            assert.deepEqual(lastRow(host).seam, { subscribers: 0 });
        } finally {
            host.stopTimers();
        }
    });
});

describe("a subscriber on the seam", () => {
    it("is called with the very event this plugin received, and unsubscribes", async () => {
        const runtime = await registered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);
        const seen = [];
        const off = noun.beforeCompact(async (e) => void seen.push(e), { name: "memory-handoff" });
        const input = compaction();

        try {
            await runtime.dispatch("session.compact", host.$, input, compactNext());

            assert.equal(seen.length, 1);
            assert.equal(seen[0], input);

            const row = lastRow(host);

            assert.equal(row.seam.subscribers, 1);
            assert.equal(row.seam.results.length, 1);
            assert.equal(row.seam.results[0].name, "memory-handoff");
            assert.equal(row.seam.results[0].outcome, "ok");
            assert.equal(typeof row.seam.results[0].elapsedMs, "number");

            off();

            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            assert.deepEqual(lastRow(host).seam, { subscribers: 0 });
            assert.equal(seen.length, 1);
        } finally {
            off();
            host.stopTimers();
        }
    });

    it("is named anonymous when it did not name itself", async () => {
        const runtime = await registered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);
        const off = noun.beforeCompact(async () => {});

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            assert.equal(lastRow(host).seam.results[0].name, "anonymous");
        } finally {
            off();
            host.stopTimers();
        }
    });

    // Each side waits for the other to have started, so a seam that ran before
    // the fork or after it deadlocks and the deadline turns that into a
    // failure. Nothing here depends on which of the two goes first.
    it("runs beside the fork rather than before or after it", async () => {
        const runtime = await registered();
        const host = seamHost();
        let forkStarted = () => {};
        let seamStarted = () => {};
        const forkIsRunning = new Promise((resolve) => (forkStarted = resolve));
        const seamIsRunning = new Promise((resolve) => (seamStarted = resolve));
        let forkSawTheSeam = false;
        let seamSawTheFork = false;

        host.$.model = {
            fork: async () => {
                forkStarted();
                await withDeadline(seamIsRunning, "the seam");
                forkSawTheSeam = true;

                return { text: "A handoff.", usage: { input_tokens: 1 } };
            },
        };

        const noun = await seamNoun(runtime, host.$);
        const off = noun.beforeCompact(
            async () => {
                seamStarted();
                await withDeadline(forkIsRunning, "the fork");
                seamSawTheFork = true;
            },
            { name: "memory-handoff" },
        );

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            assert.equal(forkSawTheSeam, true);
            assert.equal(seamSawTheFork, true);
            assert.equal(lastRow(host).seam.results[0].outcome, "ok");
        } finally {
            off();
            host.stopTimers();
        }
    });

    it("is abandoned once it runs past the cap, and the compaction goes on", async () => {
        const runtime = await registered();
        const host = seamHost({ env: { COMPACT_HANDOFF_SEAM_TIMEOUT_MS: "20" } });
        const noun = await seamNoun(runtime, host.$);
        const off = noun.beforeCompact(() => new Promise(() => {}), { name: "slow" });
        const next = compactNext();

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
            off();
            host.stopTimers();
        }
    });

    it("cannot change what this plugin does by throwing", async () => {
        const runtime = await registered();
        const alone = seamHost();

        await runtime.dispatch("session.compact", alone.$, compaction(), compactNext());

        const control = lastRow(alone);

        alone.stopTimers();

        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);
        const off = noun.beforeCompact(
            () => {
                throw new Error("the subscriber broke");
            },
            { name: "broken" },
        );
        const next = compactNext();

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), next);

            const row = lastRow(host);

            assert.equal(row.seam.results[0].outcome, "threw");
            assert.equal(row.outcome, control.outcome);
            assert.equal(row.disposition, control.disposition);
            assert.equal(next.calls.length, 1);
        } finally {
            off();
            host.stopTimers();
        }
    });

    it("is not called on a compaction this plugin only passes through", async () => {
        const runtime = await registered();
        const host = seamHost();
        const noun = await seamNoun(runtime, host.$);
        let calls = 0;
        const off = noun.beforeCompact(async () => void (calls += 1));

        try {
            await runtime.dispatch("session.compact", host.$, compaction({ agentId: "agent-1" }), compactNext());

            const row = lastRow(host);

            assert.equal(row.disposition, "passedThrough");
            assert.equal(row.seam, undefined);
            assert.equal(calls, 0);
        } finally {
            off();
            host.stopTimers();
        }
    });

    it("is not called once the session is over its budget", async () => {
        const runtime = await registered();
        const host = seamHost({ env: { COMPACT_HANDOFF_MAX_USD_PER_SESSION: "0" } });
        const noun = await seamNoun(runtime, host.$);
        let calls = 0;
        const off = noun.beforeCompact(async () => void (calls += 1));

        try {
            await runtime.dispatch("session.compact", host.$, compaction(), compactNext());

            const row = lastRow(host);

            assert.equal(row.disposition, "overBudget");
            assert.equal(row.seam, undefined);
            assert.equal(calls, 0);
        } finally {
            off();
            host.stopTimers();
        }
    });
});
