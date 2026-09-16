/**
 * Conversations shaped like the ones that have actually broken something.
 *
 * Every fixture here exists because a real run got it wrong, or because a real
 * run would have if nobody had looked. The two tool-use shapes are the headline:
 * the declarations and the running engine disagree, and a ledger written against
 * either one alone silently renders every call as "?".
 */

/** Build 2.1.270's shape, measured off a live hook: `tool` and `tool_use_id`. */
export const use270 = (tool, input, extra = {}) => ({
    tool_use_id: `toolu_${tool}_${Math.abs(hash(JSON.stringify(input)))}`,
    tool,
    input,
    result: extra.text ?? "",
    text: extra.text ?? "",
    ...extra,
});

/** What `types/claude-code.d.ts` out of 2.1.269 declares: `name` and `id`. */
export const use269 = (name, input, extra = {}) => ({
    id: `toolu_${name}_${Math.abs(hash(JSON.stringify(input)))}`,
    name,
    input,
    result: extra.text ?? "",
    text: extra.text ?? "",
    ...extra,
});

const hash = (text) => {
    let value = 0;

    for (const char of text) {
        value = (value * 31 + char.codePointAt(0)) | 0;
    }

    return value;
};

export const userTurn = (text, extra = {}) => ({
    role: "user",
    handle: "h-user",
    text,
    toolUses: [],
    ...extra,
});

export const assistantTurn = (text, toolUses = []) => ({
    role: "assistant",
    text,
    toolUses,
});

/** A user turn that is really a tool result travelling back to the model. */
export const toolResultTurn = () => ({
    role: "user",
    handle: "h-result",
    text: "the output",
    toolUses: [],
    toolResults: [{ tool_use_id: "toolu_x", text: "the output" }],
});

/** 30k characters a person pasted in, which is what the size guard is for. */
export const pastedBlob = (chars = 30_000) => userTurn(`Here is the file:\n${"x".repeat(chars)}`);

/** A message from a peer session: a user turn, and not the person. */
export const crossSessionTurn = () =>
    userTurn(
        'Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1001/cc-socks/1.sock" from-name="peer">\nPhase 5 is yours.\n</cross-session-message>',
    );

export const taskNotificationTurn = () =>
    userTurn("<task-notification>\n<task-id>abc</task-id>\n<output-file>/tmp/x</output-file>\n</task-notification>");

export const idleNoticeTurn = () =>
    userTurn('[Cross-session idle notice] "peer", which you asked to be notified about, is idle now.');

export const continuationTurn = () =>
    userTurn(
        "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.",
    );

export const commandOutputTurn = () => userTurn("<local-command-stdout>Effort level set to auto</local-command-stdout>");

/**
 * The conversation both ledger shapes are read from: one write, one good shell
 * command, one command that failed with a flag, and one that failed with no
 * flag at all and only says so in its stdout.
 */
export const mixedConversation = (make) => [
    userTurn("Fix the build."),
    assistantTurn("Reading the file.", [make("Read", { file_path: "/repo/src/a.ts" }, { text: "export const a = 1;" })]),
    assistantTurn("Writing it.", [make("Write", { file_path: "/repo/src/a.ts" }, { text: "ok" })]),
    assistantTurn("Running the gate.", [
        make("Bash", { command: "npm run check" }, { text: "All checks passed." }),
        make("Bash", { command: "npm test" }, { text: "boom", isError: true }),
        make(
            "Bash",
            { command: "ugrep -r needle /repo" },
            { text: "ugrep: warning: /repo/gone: No such file or directory" },
        ),
        make("Bash", { command: "git status --short" }),
    ]),
];

/* ------------------------------------------------------------------ *
 * A host to dispatch a hook against.
 * ------------------------------------------------------------------ */

/**
 * The `on` the runtime hands `register`, remembering what was registered.
 *
 * `dispatch` picks a handler the way the engine does: a matcher whose every
 * key the input carries wins, and the unmatched registration is the fallback,
 * so the `precompute` hook and the general `session.compact` hook can both be
 * reached from one place.
 */
export const fakeRuntime = () => {
    const registered = [];
    const on = (event, first, second) => {
        registered.push({
            event,
            match: second === undefined ? null : first,
            handler: second === undefined ? first : second,
        });
    };

    const handlerFor = (event, input) => {
        const candidates = registered.filter((entry) => entry.event === event);
        const matched = candidates.find(
            (entry) => entry.match !== null && Object.entries(entry.match).every(([key, value]) => input?.[key] === value),
        );

        return (matched ?? candidates.find((entry) => entry.match === null))?.handler ?? null;
    };

    return {
        on,
        registered,
        dispatch: async (event, $, input, next = passThrough()) => {
            const handler = handlerFor(event, input);

            if (handler === null) {
                throw new Error(`nothing is registered for ${event}`);
            }

            return handler($, input, next);
        },
    };
};

/** The `next` a dispatch carries: answers, and remembers that it was reached. */
export const passThrough = () => {
    const next = (input) => {
        next.calls.push(input);

        return { passedThrough: true };
    };

    next.calls = [];
    next.signal = undefined;

    return next;
};

/**
 * The `$` a hook is handed, in memory.
 *
 * `clock.now` deliberately answers a **Promise**, which is what engine 2.1.273
 * really does against a declaration that says `number`. Nothing in the module
 * may depend on it: every duration is `Date.now()`, which is right whichever
 * the engine returns. Anything a test steers goes in `overrides`.
 */
export const fakeApi = (overrides = {}) => {
    const files = new Map(Object.entries(overrides.files ?? {}));
    const store = new Map();
    const env = { HOME: "/home/nobody", ...overrides.env };
    const appends = [];
    const toasts = [];

    files.set("/plugin/.claude-plugin/plugin.json", JSON.stringify({ version: "0.0.0-test" }));

    const $ = {
        plugin: { root: "/plugin" },
        env: { get: async (name) => env[name] },
        store: {
            get: async (key) => store.get(key),
            set: async (key, value) => void store.set(key, value),
            delete: async (key) => void store.delete(key),
        },
        fs: {
            read: async (path) => {
                if (!files.has(path)) {
                    throw new Error(`no such file: ${path}`);
                }

                return files.get(path);
            },
            write: async (path, text) => void files.set(path, text),
            exists: async (path) => files.has(path),
            list: async () => [],
        },
        // `appendLine` is the only caller, as
        // `sh -c '... "$1"' compact-handoff <file>` with the row on stdin.
        process: {
            run: async (argv, options = {}) => {
                appends.push({ file: argv.at(-1), line: (options.stdin ?? "").trimEnd() });

                return { code: 0, stdout: "", stderr: "" };
            },
        },
        session: {
            id: async () => "session-under-test",
            cwd: async () => "/repo",
            model: async () => "claude-sonnet-5",
            messages: async () => overrides.messages ?? [],
            usage: async () => ({ context: { tokens: 12_000, window: 200_000, percent: 6 } }),
            ...overrides.session,
        },
        ui: { toast: (text, options) => void toasts.push({ text, options }), log: () => {} },
        clock: { now: () => Promise.resolve(Date.now()), sleep: async () => {}, ...overrides.clock },
    };

    return {
        $,
        files,
        store,
        toasts,
        appends,
        /** Every row appended to a log whose path ends in `name`, parsed. */
        rowsIn: (name) => appends.filter((entry) => entry.file.endsWith(name)).map((entry) => JSON.parse(entry.line)),
    };
};
