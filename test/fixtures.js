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
