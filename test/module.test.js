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
