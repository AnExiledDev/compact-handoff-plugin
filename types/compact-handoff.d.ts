// The type contract of `$.compactHandoff`, the noun this plugin's hooks module
// adds at `engine.create`.
//
// `plugin.json`'s `types` field points here. `/plugin-types` copies this file
// to `.claude/types/claude-code-plugins/compact-handoff.d.ts` and indexes it in
// `claude-code-plugins.d.ts`, so a plugin that subscribes to the seam types
// against the real shape instead of a README. `claude plugin validate` checks
// it. Self-contained by rule: no import, export-from, require or reference.

/**
 * What `beforeCompact` takes: the tool this plugin raises when a compaction is
 * about to happen, beside its own fork.
 *
 * The seam carries strings and nothing else. Every plugin runs in its own
 * environment and an interface call's arguments cross through `cloneInto`,
 * which throws `DataCloneError` on a function, so a subscriber names a TOOL it
 * answers rather than handing over a callback.
 */
export interface CompactHandoffSubscribeOptions {
    /** The full name of the tool to raise, as `$.tool.call` spells it. */
    tool: string;
    /** What to call the subscriber in this plugin's own records; the tool name when omitted. */
    name?: string;
}

/** What `beforeCompact` resolves: the subscription, and the tool it is keyed by. */
export interface CompactHandoffSubscribeResult {
    subscribed: true;
    tool: string;
}

/**
 * The noun `$.compactHandoff`: how another plugin runs its own work beside this
 * plugin's compaction fork.
 *
 * It exists because a plugin keyed after this one in `enabledPlugins` never
 * sees `session.compact` at all — this plugin answers that event without
 * calling `next`. There is no unsubscribe, and a subscription lives for the
 * load; subscribing twice with one tool is once.
 */
export interface CompactHandoff {
    /**
     * Registers the tool raised when a compaction is about to happen.
     *
     * Rejects with a `TypeError` when `tool` is missing or blank.
     */
    beforeCompact: (options: CompactHandoffSubscribeOptions) => Promise<CompactHandoffSubscribeResult>;
    /** This plugin's version, for a subscriber that wants to know what it got. */
    version: () => Promise<string>;
}

declare module 'claude-code' {
    interface EngineInterface {
        compactHandoff: CompactHandoff;
    }
}
