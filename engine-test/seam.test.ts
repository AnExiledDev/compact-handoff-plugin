// The seam, driven through the real engine.
//
// `bun test` covers this module's own functions against a stub `$`. What it
// cannot do is load the plugin into an engine and reach the noun the way a
// subscriber reaches it, which is the one part of this plugin another plugin
// depends on and the whole of what `types/compact-handoff.d.ts` promises.
// `claude plugin test` runs each file here in a child of the Claude Code
// binary with the plugin loaded, so the probe below sits beneath it exactly
// as memory-handoff does.
//
// The probe is an inline plugin rather than a hook registered in the test
// body, and that is forced, not a preference: the engine's static scan reads
// `$.<noun>.<event>` off a hooks module's `register`, a hook closed over by a
// test body is not scanned, and every call such a hook makes on another
// plugin's noun is refused with "its hooks module does not call it". A
// `register` closes over nothing, so what the probe learns comes back out
// through the tool call that asked for it.
import { expect, test, tier } from "claude-code/testing";
import type { Register } from "claude-code";
import type { Engine } from "claude-code/testing";

tier("user");

const PROBE_TOOL = "probe_seam";

const register: Register = (on) => {
    on("tool.call", { tool: "probe_seam" }, async ($) => {
        const version = await $.compactHandoff.version();
        const subscribed = await $.compactHandoff.beforeCompact({
            tool: "mcp__probe__before_compact",
            name: "probe",
        });

        let refusal = null;

        try {
            await $.compactHandoff.beforeCompact({ tool: "   " });
        } catch (error) {
            refusal = String(error);
        }

        return { result: JSON.stringify({ version, subscribed, refusal }) };
    });
};

const probe = { name: "probe", register };

/** The probe's reading, out of the tool result the engine answered with. */
const ask = async (engine: Engine) => {
    const answer = await engine.tool.call({ tool: "probe_seam", input: {} });

    return JSON.parse(JSON.parse(JSON.stringify(answer)).result);
};

test("the noun is there, and a subscriber beneath the plugin reads its version", { plugins: [probe] }, async (engine) => {
    const seen = await ask(engine);

    expect(seen.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("beforeCompact answers with the subscription it took", { plugins: [probe] }, async (engine) => {
    const seen = await ask(engine);

    expect(seen.subscribed).toEqual({ subscribed: true, tool: "mcp__probe__before_compact" });
});

test("beforeCompact refuses a blank tool, so a subscriber hears about it rather than never being raised", { plugins: [probe] }, async (engine) => {
    const seen = await ask(engine);

    expect(seen.refusal).toMatch(/takes \{ tool \}/);
});
