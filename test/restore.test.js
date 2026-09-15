import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    RESTORE_MAX_FILES,
    chooseRestores,
    clipRestore,
    fitRestores,
    parseRestoreRequests,
    restoreCandidates,
    restorePair,
    restoreRow,
} from "../hooks/restore.js";
import { assistantTurn, use270, userTurn } from "./fixtures.js";

const summaryWithBlock = (lines) =>
    `<summary>\nthe work\n</summary>\n<restore-files>\n${lines.join("\n")}\n</restore-files>`;

describe("parseRestoreRequests", () => {
    it("strips the block out of the summary and reads each line", () => {
        const parsed = parseRestoreRequests(summaryWithBlock(["/a/b.ts | 40-120 | the function being changed", "/a/c.md | all | the spec"]));

        assert.equal(parsed.summary, "<summary>\nthe work\n</summary>");
        assert.deepEqual(parsed.requests, [
            { path: "/a/b.ts", from: 40, to: 120, reason: "the function being changed" },
            { path: "/a/c.md", from: null, to: null, reason: "the spec" },
        ]);
    });

    it("asks for nothing when there is no block or an empty one", () => {
        assert.deepEqual(parseRestoreRequests("<summary>\nx\n</summary>"), { summary: "<summary>\nx\n</summary>", requests: [] });
        assert.deepEqual(parseRestoreRequests(summaryWithBlock([])).requests, []);
    });

    it("tolerates backticks, a bad range and comment lines", () => {
        const parsed = parseRestoreRequests(summaryWithBlock(["# files", "`/a/b.ts` | 200-100 | reversed range", "- not a request", "/a/d.ts"]));

        assert.deepEqual(parsed.requests, [{ path: "/a/b.ts", from: null, to: null, reason: "reversed range" }]);
    });

    it("takes the last block when the summary quotes an earlier one", () => {
        const text = `${summaryWithBlock(["/old.ts | all | quoted"])}\n<restore-files>\n/new.ts | all | real\n</restore-files>`;

        assert.deepEqual(parseRestoreRequests(text).requests.map((request) => request.path), ["/new.ts"]);
    });
});

const readOf = (path, text, extra = {}) => use270("Read", { file_path: path }, { text, ...extra });

const conversation = () => [
    userTurn("start"),
    assistantTurn("reading", [readOf("/w/a.ts", "a v1")]),
    assistantTurn("editing", [use270("Edit", { file_path: "/w/b.ts", old_string: "x", new_string: "y" })]),
    assistantTurn("reading again", [readOf("/w/a.ts", "a v2")]),
    assistantTurn("failed read", [readOf("/w/missing.ts", "no such file", { isError: true })]),
    assistantTurn("memory", [readOf("/w/AGENTS.md", "rules")]),
    assistantTurn("shell", [use270("Bash", { command: "ls" })]),
];

describe("restoreCandidates", () => {
    it("lists every file touched, newest first, with the last good Read's text", () => {
        const candidates = restoreCandidates(conversation());

        assert.deepEqual(candidates.map((candidate) => candidate.path), ["/w/AGENTS.md", "/w/missing.ts", "/w/a.ts", "/w/b.ts"]);
        assert.equal(candidates.find((candidate) => candidate.path === "/w/a.ts").stored, "a v2");
        assert.equal(candidates.find((candidate) => candidate.path === "/w/b.ts").stored, null);
        assert.equal(candidates.find((candidate) => candidate.path === "/w/missing.ts").stored, null);
    });

    it("ignores tools that do not name a file", () => {
        assert.deepEqual(restoreCandidates([assistantTurn("x", [use270("Bash", { command: "cat /w/a.ts" })])]), []);
    });
});

describe("chooseRestores", () => {
    const candidates = restoreCandidates(conversation());

    it("keeps what the model asked for when the session touched it", () => {
        const chosen = chooseRestores({ requests: [{ path: "/w/b.ts", from: 1, to: 9, reason: "edited" }], candidates });

        assert.equal(chosen.source, "model");
        assert.deepEqual(chosen.files, [{ path: "/w/b.ts", from: 1, to: 9, reason: "edited", stored: null }]);
        assert.deepEqual(chosen.rejected, []);
    });

    it("refuses a file the session never touched, a memory file, a duplicate and the overflow", () => {
        const requests = [
            { path: "/w/never.ts", from: null, to: null, reason: "" },
            { path: "/w/AGENTS.md", from: null, to: null, reason: "" },
            { path: "/w/a.ts", from: null, to: null, reason: "" },
            { path: "a.ts", from: null, to: null, reason: "relative twin" },
        ];
        const chosen = chooseRestores({ requests, candidates, maxFiles: 1 });

        assert.equal(chosen.source, "model");
        assert.deepEqual(chosen.files.map((file) => file.path), ["/w/a.ts"]);
        assert.deepEqual(chosen.rejected.map((rejection) => rejection.why), [
            "not read or written in this conversation",
            "memory file; the engine re-emits it on the next turn",
            "named twice",
        ]);
    });

    it("caps the model's list at maxFiles", () => {
        const requests = ["/w/a.ts", "/w/b.ts"].map((path) => ({ path, from: null, to: null, reason: "" }));
        const chosen = chooseRestores({ requests, candidates, maxFiles: 1 });

        assert.deepEqual(chosen.files.map((file) => file.path), ["/w/a.ts"]);
        assert.deepEqual(chosen.rejected, [{ path: "/w/b.ts", why: "over the cap of 1 files" }]);
    });

    it("falls back to recency, skipping memory files, when nothing usable was named", () => {
        const chosen = chooseRestores({ requests: [{ path: "/nope", from: null, to: null, reason: "" }], candidates, maxFiles: 2 });

        assert.equal(chosen.source, "recency");
        assert.deepEqual(chosen.files.map((file) => file.path), ["/w/missing.ts", "/w/a.ts"]);
        assert.equal(chosen.rejected.length, 1);
    });

    it("says none when the session touched no file at all", () => {
        assert.deepEqual(chooseRestores({ requests: [], candidates: [] }), { files: [], source: "none", rejected: [] });
    });

    it("defaults the cap to the engine's own five", () => {
        assert.equal(RESTORE_MAX_FILES, 5);
    });
});

describe("restorePair", () => {
    it("is a real Read tool_use and its tool_result under one id", () => {
        const pair = restorePair({ id: "toolu_1", path: "/w/a.ts", from: 40, to: 120, text: "body" });

        assert.deepEqual(pair, [
            { role: "assistant", text: "", toolUses: [{ tool_use_id: "toolu_1", tool: "Read", input: { file_path: "/w/a.ts", offset: 40, limit: 81 } }] },
            { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "toolu_1", text: "body" }] },
        ]);
    });

    it("omits offset and limit for a whole file", () => {
        assert.deepEqual(restorePair({ id: "t", path: "/w/a.ts", from: null, to: null, text: "" })[0].toolUses[0].input, { file_path: "/w/a.ts" });
    });
});

describe("clipRestore", () => {
    it("leaves a file under the cap alone", () => {
        assert.deepEqual(clipRestore("short", 10), { text: "short", clippedChars: 0 });
    });

    it("cuts the tail and says how much went", () => {
        const clipped = clipRestore("x".repeat(30), 10);

        assert.equal(clipped.clippedChars, 20);
        assert.ok(clipped.text.startsWith("x".repeat(10)));
        assert.match(clipped.text, /clipped 20 characters/u);
    });
});

describe("fitRestores", () => {
    it("drops later files once the total is spent and keeps the first named", () => {
        const files = [
            { path: "/1", text: "a".repeat(60), source: "fresh" },
            { path: "/2", text: null, source: "failed" },
            { path: "/3", text: "b".repeat(50), source: "fresh" },
            { path: "/4", text: "c".repeat(30), source: "stored" },
        ];
        const fitted = fitRestores(files, 100);

        assert.deepEqual(fitted.map((file) => file.source), ["fresh", "failed", "dropped", "stored"]);
        assert.equal(fitted[2].text, null);
        assert.match(fitted[2].detail, /total budget of 100/u);
    });
});

describe("restoreRow", () => {
    it("carries every number the caps could be tuned on", () => {
        const row = restoreRow({ path: "/w/a.ts", from: 1, to: 9, reason: "r", source: "fresh", text: "x".repeat(8), clippedChars: 3, detail: "", ms: 12 });

        assert.deepEqual(row, { path: "/w/a.ts", lines: "1-9", reason: "r", source: "fresh", chars: 8, approxTokens: 2, clippedChars: 3, ms: 12 });
    });

    it("zeroes a file that did not come back and keeps the reason it did not", () => {
        const row = restoreRow({ path: "/w/a.ts", from: null, to: null, reason: "r", source: "dropped", text: null, detail: "too big", ms: 0 });

        assert.equal(row.lines, "all");
        assert.equal(row.chars, 0);
        assert.equal(row.detail, "too big");
    });
});
