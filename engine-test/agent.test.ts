// The handoff agent type, registered through the real engine.
//
// `$.agent.register` has no stub worth writing: what matters is the spec the
// engine accepts, and only the engine knows what it accepts. These tests catch
// the spec drifting out of what a build will take, which would otherwise show
// up as a session that quietly falls back to `general-purpose` and pays for a
// CLAUDE.md on every refresh.
import { expect, test, tier } from "claude-code/testing";
import type { Register } from "claude-code";
import type { Engine } from "claude-code/testing";

tier("user");

const START = { cwd: "/tmp", surface: null, isInteractive: false };

/** The bottom of the chain: session.start is the only event these tests drive. */
const bottom = (on: Parameters<Register>[0]) => {
    const registered: unknown[] = [];

    const store = new Map<string, unknown>();

    on("tool.register", async ($, e) => ({ value: e }));
    on("env.get", async () => ({ value: undefined }));
    on("store.get", async ($, e) => ({ value: store.get(e.key) }));
    on("store.set", async ($, e) => {
        store.set(e.key, e.value);

        return { value: undefined };
    });
    on("agent.register", async ($, e) => {
        registered.push(e);

        return { value: { agent: `compact-handoff:${e.name}` } };
    });
    on("session.start", async ($, e) => ({ cwd: e.cwd }));

    return registered;
};

test("session.start defines the handoff agent, with no CLAUDE.md and four tools", async (engine, on) => {
    const registered = bottom(on);

    await engine.session.start(START);

    const spec = JSON.parse(JSON.stringify(registered)).find((one: { name: string }) => one.name === "handoff");

    expect(spec).toBeDefined();
    expect(spec.omitClaudeMd).toBe(true);
    expect(spec.background).toBe(true);
    expect(spec.tools).toEqual(["Read", "Write", "Grep", "Glob"]);
    expect(spec.prompt).toMatch(/handoff a Claude Code session continues from/);
    expect(spec.prompt).toMatch(/<!-- handoff-complete -->/);
});

test("a registration that does not take is recorded, and the spawn falls back", async (engine, on) => {
    // No `agent.register` at the bottom, which is how this harness spells "the
    // registration failed": nothing in a test sits beneath the plugins, so an
    // event no test answers is refused. That is the path a real deny takes too,
    // and losing it would lose the handoff rather than the agent type.
    const store = new Map<string, unknown>();
    let seam: unknown = "not read";

    on("tool.register", async ($, e) => ({ value: e }));
    on("env.get", async () => ({ value: undefined }));
    on("store.get", async ($, e) => ({ value: store.get(e.key) }));
    on("store.set", async ($, e) => {
        store.set(e.key, e.value);

        return { value: undefined };
    });
    on("session.start", async ($, e) => ({ cwd: e.cwd }));

    await engine.session.start(START);

    seam = store.get("handoffAgent");

    expect(JSON.parse(JSON.stringify(seam)).registered).toBe(false);
});
