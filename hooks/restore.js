/**
 * Restoring files after a compaction, chosen by the summariser.
 *
 * Claude Code's own compaction hands the next window up to five of the most
 * recently read files, and it renders each as a meta user message narrating a
 * Read call inside a system-reminder. That path never runs when a hook
 * replaces the messages, so until 0.3.0 a handoff came back with no files at
 * all.
 *
 * This is the pure half of the replacement. The summariser, which has read the
 * whole conversation, names the files the next window should have open, in a
 * fenced block at the end of its summary; the code here parses that block,
 * checks every path against the files the session actually touched, falls
 * back to recency when the model named nothing usable, and shapes each file
 * as a real Read tool_use and its tool_result, which is what a live read looks
 * like. (Operator, 2026-09-15: "Why wouldn't we let the model that handles the
 * compaction summary decide which files are re-read and injected", and the
 * caps are theirs to move: "if the size guard needs expanded we can expand
 * it".)
 *
 * Nothing in this file touches the host; the reads happen in `module.js`.
 */

import { PATH_SHAPED, SHELL_EXPANDED, nameOf } from "./lib.js";

/** How many files may come back; Claude Code's own restore stops at five. */
export const RESTORE_MAX_FILES = 5;

/** The most of one file that comes back, at four characters per token. */
export const RESTORE_FILE_CHARS = 20_000;

/** The most all restored files may add to the window together. */
export const RESTORE_TOTAL_CHARS = 100_000;

export const RESTORE_OPEN = "<restore-files>";
export const RESTORE_CLOSE = "</restore-files>";

/** The tools whose target is a file the session has seen. */
export const RESTORE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Memory files come back through the engine's own path; restoring them doubles them. */
export const MEMORY_FILE = /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/u;

/** One request line: an absolute path, `all` or a line range, and a reason. */
const REQUEST_LINE = /^\s*`?([^`|]+?)`?\s*\|\s*([^|]*?)\s*(?:\|\s*(.*?))?\s*$/u;

const LINE_RANGE = /^(\d+)\s*[-–]\s*(\d+)$/u;

/**
 * The block out of the summary, and the summary without it.
 *
 * A summary with no block, or an empty one, asks for nothing; the caller then
 * falls back to recency and the row says so.
 */
export const parseRestoreRequests = (text) => {
    const open = text.lastIndexOf(RESTORE_OPEN);
    const close = open === -1 ? -1 : text.indexOf(RESTORE_CLOSE, open);

    if (open === -1 || close === -1) {
        return { summary: text, requests: [] };
    }

    const body = text.slice(open + RESTORE_OPEN.length, close);
    const summary = `${text.slice(0, open)}${text.slice(close + RESTORE_CLOSE.length)}`.trim();

    return { summary, requests: body.split("\n").map(parseRequest).filter((request) => request !== null) };
};

const parseRequest = (raw) => {
    const line = raw.trim();

    if (line === "" || line.startsWith("#") || line.startsWith("-")) {
        return null;
    }

    const match = REQUEST_LINE.exec(line);

    if (match === null) {
        return null;
    }

    const range = LINE_RANGE.exec(match[2] ?? "");
    const from = range === null ? null : Number(range[1]);
    const to = range === null ? null : Number(range[2]);

    if (from !== null && (from < 1 || to < from)) {
        return { path: match[1].trim(), from: null, to: null, reason: (match[3] ?? "").trim() };
    }

    return { path: match[1].trim(), from, to, reason: (match[3] ?? "").trim() };
};

/**
 * Every file the conversation touched, most recently touched first, each with
 * the text of its last successful Read if the transcript still holds one.
 */
export const restoreCandidates = (messages) => {
    const seen = new Map();

    messages.forEach((message, index) => {
        for (const use of message.toolUses ?? []) {
            const tool = nameOf(use);

            if (!RESTORE_TOOLS.has(tool)) {
                continue;
            }

            const path = pathOf(use);

            if (path === null) {
                continue;
            }

            const prior = seen.get(path);
            const stored = tool === "Read" && use.isError !== true && typeof use.text === "string" && use.text !== ""
                ? use.text
                : (prior?.stored ?? null);

            seen.set(path, { path, at: index, stored });
        }
    });

    return [...seen.values()].sort((left, right) => right.at - left.at);
};

/**
 * Every path-shaped word a shell command named, newest command first.
 *
 * A file read with `cat` or rewritten by a script was touched as surely as one
 * that went through Read or Edit, so the model may ask for it back. These are
 * words, not resolved paths: a relative one only ever matches the tail of an
 * absolute path the model names, and none of them feeds the recency fallback,
 * which would otherwise restore whatever log a command last redirected into.
 */
export const shellMentions = (messages) => {
    const mentions = [];

    messages.forEach((message, index) => {
        for (const use of message.toolUses ?? []) {
            const command = use.input?.command;

            if (nameOf(use) !== "Bash" || typeof command !== "string") {
                continue;
            }

            for (const word of command.split(SHELL_WORD_BREAK)) {
                const token = word.slice(word.lastIndexOf("=") + 1).replace(/^\.\//u, "");

                if (PATH_SHAPED.test(token) && !SHELL_EXPANDED.test(token)) {
                    mentions.push({ token, at: index });
                }
            }
        }
    });

    return mentions.sort((left, right) => right.at - left.at);
};

const SHELL_WORD_BREAK = /[\s"'`;|&()<>,]+/u;

/** The file a shell command named, if any word it used ends the requested path. */
const shellCandidateFor = (path, mentions) => {
    const wanted = path.replace(/^\.\//u, "");

    for (const { token, at } of mentions) {
        if (token.startsWith("/") && (token === wanted || token.endsWith(`/${wanted}`))) {
            return { path: token, at, stored: null };
        }

        if (wanted.startsWith("/") && wanted.endsWith(`/${token}`)) {
            return { path: wanted, at, stored: null };
        }
    }

    return null;
};

const pathOf = (use) => {
    const input = use.input ?? {};
    const path = input.file_path ?? input.notebook_path;

    return typeof path === "string" && path.trim() !== "" ? path.trim() : null;
};

/**
 * Which files go back, and why each one the model asked for did not.
 *
 * The model chooses; the code only refuses. A path the session never touched,
 * through a file tool or by a shell command naming it, is refused because the
 * model cannot have read it, a memory file because the
 * engine re-emits those itself, and anything past the cap because the cap is
 * the operator's. A file that is gone from disk is refused too: a worktree
 * removed after its files were edited once left the fallback restoring nothing.
 * When nothing survives, the most recently touched files that still exist go
 * instead, and `source` says which of the two happened so the rate can be
 * measured. `exists` is the host's check, injected so this stays pure.
 *
 * @param {object} options
 * @param {Array<{ path: string, from: number | null, to: number | null, reason: string }>} options.requests
 * @param {Array<{ path: string, at: number, stored: string | null }>} options.candidates
 * @param {Array<{ token: string, at: number }>} [options.shellMentions] what shell commands named; see `shellMentions`
 * @param {number} [options.maxFiles]
 * @param {(path: string) => Promise<boolean>} [options.exists]
 */
export const chooseRestores = async ({ requests, candidates, shellMentions: mentions = [], maxFiles = RESTORE_MAX_FILES, exists = async () => true }) => {
    const files = [];
    const rejected = [];

    for (const request of requests) {
        const candidate = candidateFor(request.path, candidates) ?? shellCandidateFor(request.path, mentions);
        const why = refusal(request.path, candidate, files, maxFiles) ?? (await goneFromDisk(candidate, exists));

        if (why !== null) {
            rejected.push({ path: request.path, why });
            continue;
        }

        files.push({ ...request, path: candidate.path, stored: candidate.stored });
    }

    if (files.length > 0) {
        return { files, source: "model", rejected };
    }

    const fallback = [];

    for (const candidate of candidates) {
        if (fallback.length >= maxFiles) {
            break;
        }

        if (MEMORY_FILE.test(candidate.path) || !(await exists(candidate.path))) {
            continue;
        }

        fallback.push({
            path: candidate.path,
            from: null,
            to: null,
            reason: "most recently touched; the summary named no usable file",
            stored: candidate.stored,
        });
    }

    return { files: fallback, source: fallback.length === 0 ? "none" : "recency", rejected };
};

/**
 * @param {{ path: string }} candidate
 * @param {(path: string) => Promise<boolean>} exists
 */
const goneFromDisk = async (candidate, exists) => ((await exists(candidate.path)) ? null : "no longer exists on disk");

const candidateFor = (path, candidates) =>
    candidates.find((candidate) => candidate.path === path) ??
    candidates.find((candidate) => candidate.path.endsWith(`/${path.replace(/^\.\//u, "")}`)) ??
    null;

const refusal = (path, candidate, chosen, maxFiles) => {
    if (candidate === null) {
        return "not read or written in this conversation";
    }

    if (MEMORY_FILE.test(candidate.path)) {
        return "memory file; the engine re-emits it on the next turn";
    }

    if (chosen.some((file) => file.path === candidate.path)) {
        return "named twice";
    }

    if (chosen.length >= maxFiles) {
        return `over the cap of ${maxFiles} files`;
    }

    return null;
};

/**
 * The two messages the model sees for one restored file: a Read it made, and
 * what the file said. Real tool blocks, not a narration of them, so the next
 * window treats the content exactly as it treats any file it has read.
 */
export const restorePair = ({ id, path, from, to, text }) => {
    const input = { file_path: path };

    if (from !== null && to !== null) {
        input.offset = from;
        input.limit = to - from + 1;
    }

    return [
        { role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Read", input }] },
        { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text }] },
    ];
};

/** What replaces the tail of a file too large to carry whole. */
export const clipRestore = (text, maxChars) => {
    if (text.length <= maxChars) {
        return { text, clippedChars: 0 };
    }

    const kept = text.slice(0, maxChars);

    return {
        text: `${kept}\n[compact-handoff clipped ${text.length - maxChars} characters here; Read the file with an offset for the rest.]`,
        clippedChars: text.length - maxChars,
    };
};

/**
 * Fits the read files under the total budget, in the order the model gave
 * them, so the first file named is the last one dropped.
 */
export const fitRestores = (files, totalChars) => {
    let used = 0;

    return files.map((file) => {
        if (file.text === null) {
            return file;
        }

        if (used + file.text.length > totalChars) {
            return { ...file, text: null, source: "dropped", detail: `over the total budget of ${totalChars} characters` };
        }

        used += file.text.length;

        return file;
    });
};

/** The metrics row for one file, whatever happened to it. */
export const restoreRow = ({ path, from, to, reason, source, text, clippedChars, detail, ms }) => ({
    path,
    lines: from === null ? "all" : `${from}-${to}`,
    reason,
    source,
    chars: text === null ? 0 : text.length,
    approxTokens: text === null ? 0 : Math.ceil(text.length / 4),
    clippedChars: clippedChars ?? 0,
    ...(detail === undefined || detail === "" ? {} : { detail }),
    ms,
});
