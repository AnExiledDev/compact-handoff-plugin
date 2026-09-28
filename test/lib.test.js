import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    applySizeGuard,
    assistantTurns,
    commitmentsFrom,
    commitmentsOutcome,
    costOf,
    costOfNothing,
    estimatedUsage,
    fallbackReasonFor,
    forkInputOf,
    handoffCeiling,
    isPinnable,
    isReadOnlyCommand,
    LEDGER_CHARS,
    LEDGER_RECENT_COMMANDS,
    ledgerRows,
    lineageLine,
    lineageOf,
    monitorSeed,
    nameOf,
    observePost,
    openersIn,
    originOf,
    outcomeOf,
    pinSkipCounts,
    priceRowFor,
    priceUsage,
    priorHandoffIn,
    renderCommitments,
    renderLedger,
    approxTokens,
    lookupRecord,
    replacementFor,
    sectionOf,
    shellWrites,
    subagentRanThisTurn,
    summarisePrs,
    targetOf,
    windowReading,
    withoutScratchpad,
    toolIndex,
    workDone,
} from "../hooks/lib.js";

import {
    assistantTurn,
    commandOutputTurn,
    continuationTurn,
    crossSessionTurn,
    idleNoticeTurn,
    mixedConversation,
    pastedBlob,
    taskNotificationTurn,
    toolResultTurn,
    use269,
    use270,
    userTurn,
} from "./fixtures.js";

describe("the two tool-use shapes", () => {
    it("reads the name under either spelling", () => {
        assert.equal(nameOf(use270("Bash", { command: "ls" })), "Bash");
        assert.equal(nameOf(use269("Bash", { command: "ls" })), "Bash");
    });

    it("lets the declared name win when a build hands back both", () => {
        assert.equal(nameOf({ name: "Declared", tool: "Runtime" }), "Declared");
    });

    it("says so rather than guessing when neither key is there", () => {
        assert.equal(nameOf({ input: {} }), "?");
    });

    for (const [label, make] of [
        ["2.1.270 runtime", use270],
        ["2.1.269 declared", use269],
    ]) {
        it(`builds the same ledger from the ${label} shape`, () => {
            const rows = ledgerRows(mixedConversation(make));

            assert.equal(rows.length, 6);
            assert.deepEqual(
                rows.map((row) => row.name),
                ["Read", "Write", "Bash", "Bash", "Bash", "Bash"],
            );
            assert.deepEqual(
                rows.map((row) => row.outcome),
                ["ok", "ok", "ok", "errored", "unflagged, output reads as an error", "no result in transcript"],
            );
        });

        it(`counts writes and shells from the ${label} shape`, () => {
            const text = renderLedger(ledgerRows(mixedConversation(make)));

            assert.match(text, /6 tool calls \(4 shell commands\), 1 file written\./u);
            assert.match(text, /### Files written \(1\)/u);
            assert.match(text, /### Every shell command, in order \(4\)/u);
        });
    }

    // The third live compaction on 0.11.1 listed an EnterWorktree error as
    // "- ``" because only a command or a path fills the label.
    it("names the tool of a failed call that is not a shell command", () => {
        const rows = ledgerRows([
            assistantTurn("x", [
                use270("EnterWorktree", { name: "ch-ptr" }, { text: "Could not read the repository git config", isError: true }),
                use270("Edit", { file_path: "/w/a.ts" }, { text: "String not found", isError: true }),
                use270("Bash", { command: "false" }, { text: "exit 1", isError: true }),
            ]),
        ]);
        const text = renderLedger(rows);

        assert.doesNotMatch(text, /^- ``$/mu);
        assert.match(text, /^- EnterWorktree$/mu);
        assert.match(text, /^- Edit `\/w\/a\.ts`$/mu);
        assert.match(text, /^- `false`$/mu);
    });

    it("is the regression the first live compaction shipped", () => {
        // Before nameOf read `tool`, the 2.1.270 shape rendered every row as "?"
        // and the summary line read "0 file writes, 0 shell commands".
        const text = renderLedger(ledgerRows(mixedConversation(use270)));

        assert.doesNotMatch(text, /0 file writes, 0 shell commands/u);
    });
});

describe("outcomeOf", () => {
    it("trusts an error flag", () => {
        assert.equal(outcomeOf(use270("Bash", {}, { text: "boom", isError: true })).outcome, "errored");
    });

    it("does not read a missing flag as success", () => {
        const result = outcomeOf(use270("Bash", {}, { text: "ugrep: warning: /x: No such file or directory" }));

        assert.equal(result.outcome, "unflagged, output reads as an error");
        assert.match(result.detail, /No such file or directory/u);
    });

    it("distinguishes an empty result from a good one", () => {
        assert.equal(outcomeOf(use270("Bash", {}, { text: "" })).outcome, "no result in transcript");
        assert.equal(outcomeOf(use270("Bash", {}, { text: "fine" })).outcome, "ok");
    });

    it("never reports an exit code, because the transcript stores none", () => {
        const result = outcomeOf(use270("Bash", {}, { text: "fine" }));

        assert.deepEqual(Object.keys(result).sort(), ["detail", "outcome"]);
    });
});

describe("targetOf", () => {
    it("prefers a command, then a path", () => {
        assert.equal(targetOf(use270("Bash", { command: "ls -la", file_path: "/x" })), "ls -la");
        assert.equal(targetOf(use270("Read", { file_path: "/x" })), "/x");
    });

    it("flattens a multi-line command onto one row", () => {
        assert.equal(targetOf(use270("Bash", { command: "a\nb" })), "a ; b");
    });

    it("is empty when no argument names a target", () => {
        assert.equal(targetOf(use270("Task", { other: "x" })), "");
    });
});

describe("who typed a user turn", () => {
    it("keeps a person", () => {
        assert.equal(originOf(userTurn("do the thing")), "person");
        assert.ok(isPinnable(userTurn("do the thing")));
    });

    it("excludes a cross-session message even though it starts with prose", () => {
        assert.equal(originOf(crossSessionTurn()), "cross-session");
        assert.equal(isPinnable(crossSessionTurn()), false);
    });

    it("excludes the harness's own turns", () => {
        assert.equal(originOf(taskNotificationTurn()), "task-notification");
        assert.equal(originOf(idleNoticeTurn()), "idle-notice");
        assert.equal(originOf(continuationTurn()), "continuation");
        assert.equal(originOf(commandOutputTurn()), "command-output");
    });

    it("keeps a slash command, because the person typed it", () => {
        assert.equal(originOf(userTurn("<command-name>/loop</command-name>")), "person");
    });

    it("excludes a turn with no handle, whatever it says", () => {
        assert.equal(isPinnable({ role: "user", text: "hi", toolUses: [] }), false);
    });

    it("excludes a tool result wearing a user turn's clothes", () => {
        assert.equal(isPinnable(toolResultTurn()), false);
    });

    it("counts what it skipped, by kind", () => {
        const counts = pinSkipCounts([
            userTurn("real"),
            crossSessionTurn(),
            crossSessionTurn(),
            idleNoticeTurn(),
            toolResultTurn(),
        ]);

        assert.deepEqual(counts, { "cross-session": 2, "idle-notice": 1 });
    });
});

describe("replacementFor", () => {
    it("puts the handoff first and pins only the person's turns", () => {
        const messages = [userTurn("first"), assistantTurn("working"), crossSessionTurn(), userTurn("second")];
        const out = replacementFor(messages, "THE HANDOFF");

        assert.equal(out.length, 3);
        assert.equal(out[0].role, "assistant");
        assert.equal(out[0].text, "THE HANDOFF");
        assert.deepEqual(
            out.slice(1).map((m) => m.text),
            ["first", "second"],
        );
    });

    it("hands the pinned turns back as words only, without the engine's handle", () => {
        const out = replacementFor([userTurn("first")], "H");

        assert.equal(out[1].handle, undefined);
        assert.deepEqual(out[1], { role: "user", text: "first", toolUses: [] });
    });

    it("survives a conversation with nothing in it", () => {
        assert.deepEqual(replacementFor([], "H"), [{ role: "assistant", text: "H", toolUses: [] }]);
    });
});

describe("the size guard", () => {
    const pointerFor = ({ chars }) => `[trimmed ${chars} chars; see handoff_lookup]`;

    it("leaves a conversation that already fits alone", () => {
        const messages = replacementFor([userTurn("short")], "H");
        const out = applySizeGuard(messages, { maxChars: 10_000, pointerFor });

        assert.equal(out.trimmedTurns, 0);
        assert.equal(out.messages, messages);
        assert.equal(out.overCeiling, false);
    });

    it("replaces the largest pasted turn until it fits", () => {
        const messages = replacementFor([pastedBlob(30_000), userTurn("keep me")], "H");
        const out = applySizeGuard(messages, { maxChars: 1000, pointerFor });

        assert.equal(out.trimmedTurns, 1);
        assert.ok(out.charsAfter < out.charsBefore);
        assert.ok(out.charsAfter <= 1000);
        assert.match(out.messages[1].text, /trimmed 30/u);
        assert.equal(out.messages[2].text, "keep me");
    });

    it("never trims the summary, even when the summary alone is over", () => {
        const summary = "S".repeat(5000);
        const messages = replacementFor([userTurn("small")], summary);
        const out = applySizeGuard(messages, { maxChars: 100, pointerFor });

        assert.equal(out.messages[0].text, summary);
        assert.equal(out.overCeiling, true);
    });

    it("does not swap a turn for a pointer that is longer than it", () => {
        const messages = replacementFor([userTurn("hi")], "H".repeat(2000));
        const out = applySizeGuard(messages, { maxChars: 10, pointerFor });

        assert.equal(out.messages[1].text, "hi");
        assert.equal(out.trimmedTurns, 0);
    });

    it("trims biggest-first, so one blob goes before three small turns", () => {
        const messages = replacementFor([userTurn("a".repeat(400)), pastedBlob(9000), userTurn("b".repeat(400))], "H");
        const out = applySizeGuard(messages, { maxChars: 1200, pointerFor });

        assert.equal(out.trimmedTurns, 1);
        assert.equal(out.messages[1].text, "a".repeat(400));
        assert.equal(out.messages[3].text, "b".repeat(400));
    });
});

describe("lineage", () => {
    it("round-trips", () => {
        const line = lineageLine({ session: "abc-123", n: 3, prev: 2 });

        assert.deepEqual(lineageOf(line), { session: "abc-123", n: 3, prev: 2 });
    });

    it("records a first compaction as having no predecessor", () => {
        assert.deepEqual(lineageOf(lineageLine({ session: "s", n: 1, prev: null })), {
            session: "s",
            n: 1,
            prev: null,
        });
    });

    it("is null for ordinary prose", () => {
        assert.equal(lineageOf("## Tool ledger\n\nsome text"), null);
        assert.equal(lineageOf(""), null);
        assert.equal(lineageOf(undefined), null);
    });

    it("finds the most recent handoff in a conversation", () => {
        const messages = [
            assistantTurn(`${lineageLine({ session: "s", n: 1, prev: null })}\nfirst handoff`),
            userTurn("carry on"),
            assistantTurn(`${lineageLine({ session: "s", n: 2, prev: 1 })}\nsecond handoff`),
            userTurn("more"),
        ];

        assert.deepEqual(priorHandoffIn(messages), { index: 2, lineage: { session: "s", n: 2, prev: 1 } });
    });

    it("is null when the conversation carries no handoff", () => {
        assert.equal(priorHandoffIn([userTurn("hi"), assistantTurn("there")]), null);
    });

    // A session that read its own history (handoff_lookup, a Read of a stored
    // handoff, the README's example marker) carried an older marker after its
    // real handoff, and the next compaction took its depth from the quote.
    it("does not take a marker quoted in a tool result or in prose for a handoff", () => {
        const messages = [
            assistantTurn(`${lineageLine({ session: "s", n: 7, prev: 6 })}\nthe handoff`),
            { ...toolResultTurn(), text: `${lineageLine({ session: "s", n: 3, prev: 2 })}\nhandoff 3, looked up` },
            assistantTurn("The README says each handoff opens with <!-- compact-handoff: session=<id> n=003 prev=002 -->."),
        ];

        assert.equal(priorHandoffIn(messages).lineage.n, 7);
    });
});

describe("the ledger carries only this compaction's rows", () => {
    it("never renders an earlier compaction, however many are passed", () => {
        const rows = ledgerRows(mixedConversation(use270));
        const text = renderLedger(rows, [{ n: 1, at: "2026-09-14T07:00:00Z", rows }]);

        assert.doesNotMatch(text, /Before compaction/u);
        assert.match(text, /### Files written/u);
    });

    it("does not grow with depth", () => {
        const rows = ledgerRows(mixedConversation(use270));
        const first = renderLedger(rows);
        const tenth = renderLedger(rows, Array.from({ length: 9 }, (_, n) => ({ n: n + 1, rows })));

        assert.equal(tenth.length, first.length);
    });

    it("is empty when this stretch ran no tools", () => {
        assert.equal(renderLedger([]), "");
        assert.equal(renderLedger(ledgerRows([])), "");
    });
});

/** One assistant turn running each command, every one answering `done`. */
const shellWindow = (commands) =>
    ledgerRows([assistantTurn("x", commands.map((command) => use270("Bash", { command }, { text: "done" })))]);

// Operator, 2026-09-28: "I think we should limit the shell-command list length,
// or trim it of unimportant commands, something needs to be done there, it
// concerns me on long multi-compact sessions". The largest windows ran 87-95
// commands and rendered 15-21k characters of list.
describe("a long shell window is trimmed, and the trim says where the rest is", () => {
    it("keeps the newest commands in order whatever they were, and counts the rest", () => {
        const commands = Array.from({ length: 40 }, (_, index) => `ls /tmp/probe-${index}`);
        const text = renderLedger(shellWindow(commands), { n: 4 });

        assert.match(text, /### Shell commands, in order \(10 of 40\)/u);
        assert.match(text, /- 30 older commands omitted \(30 read-only\); handoff_lookup n=4 section=ledger lists every one\./u);
        assert.doesNotMatch(text, /probe-29`/u);
        assert.ok(text.indexOf("probe-30`") < text.indexOf("probe-39`"));
        assert.equal(LEDGER_RECENT_COMMANDS, 10);
    });

    it("drops read-only probes before any older command that changed something", () => {
        const commands = Array.from({ length: 30 }, (_, index) =>
            index % 2 === 0 ? `grep -n thing src/file-${index}.ts` : `touch /w/made-${index}`,
        );
        const text = renderLedger(shellWindow(commands), { n: 2 });

        for (let index = 1; index < 20; index += 2) {
            assert.match(text, new RegExp(`made-${index}\``, "u"));
        }

        assert.doesNotMatch(text, /file-0\.ts/u);
        assert.match(text, /- 10 older commands omitted \(10 read-only\)/u);
    });

    it("fits the worst measured window inside LEDGER_CHARS", () => {
        const commands = Array.from({ length: 95 }, (_, index) => `sed -i 's/old/new/' /w/src/module-${index}.ts && ${"x".repeat(260)}`);
        const text = renderLedger(shellWindow(commands), { n: 3 });

        assert.ok(text.length <= LEDGER_CHARS, `ledger is ${text.length} characters`);
        assert.match(text, /older commands omitted/u);
    });

    it("clips a kept command to about half a line", () => {
        const text = renderLedger(shellWindow([`echo ${"y".repeat(400)}`]));

        assert.doesNotMatch(text, /y{200}/u);
    });

    it("renders every command at full length for handoff_lookup", () => {
        const commands = Array.from({ length: 40 }, (_, index) => `ls /tmp/probe-${index} ${"z".repeat(200)}`);
        const text = renderLedger(shellWindow(commands), { full: true });

        assert.match(text, /### Every shell command, in order \(40\)/u);
        assert.match(text, /probe-0 z{200}/u);
        assert.doesNotMatch(text, /omitted/u);
    });

    it("shows the newest twenty failures and counts the older ones", () => {
        const rows = ledgerRows([
            assistantTurn(
                "x",
                Array.from({ length: 25 }, (_, index) => use270("Bash", { command: `false ${index}` }, { text: "exit 1", isError: true })),
            ),
        ]);
        const text = renderLedger(rows);

        assert.match(text, /### Output that reads as a failure \(25\)/u);
        assert.match(text, /- 5 older failures omitted/u);
        assert.doesNotMatch(text.split(/### (?:Every shell command|Shell commands)/u)[0], /`false 4`/u);
        assert.match(text, /`false 5`/u);
    });
});

// Operator, 2026-09-28: "sometimes work is done through shell commands that
// should be preserved."
describe("a file written through the shell is a file write", () => {
    it("is listed under Files written and counted in the header", () => {
        const text = renderLedger(shellWindow(["sed -i 's/a/b/' src/x.ts", "ls"]));

        assert.match(text, /2 tool calls \(2 shell commands\), 1 file written\./u);
        assert.match(text, /### Files written \(1\)/u);
        assert.match(text, /^- Bash `src\/x\.ts`$/mu);
    });

    // A live 0.11.3 handoff said "42 tool calls: 17 file writes, 37 shell
    // commands", 54 of 42, and headed a list of 14 files "(17 calls)": the
    // shell writes were counted as calls on top of the Bash calls they came
    // from, and a file written twice was counted twice and listed once.
    it("counts files, not calls, and names each file once with every tool that wrote it", () => {
        const rows = ledgerRows([
            assistantTurn("x", [
                use270("Write", { file_path: "/w/a.md", content: "a" }, { text: "ok" }),
                use270("Edit", { file_path: "/w/a.md", old_string: "a", new_string: "b" }, { text: "ok" }),
                use270("Bash", { command: "echo x > /w/a.md" }, { text: "" }),
                use270("Edit", { file_path: "/w/b.js", old_string: "a", new_string: "b" }, { text: "ok" }),
            ]),
        ]);
        const text = renderLedger(rows);

        assert.match(text, /4 tool calls \(1 shell command\), 2 files written\./u);
        assert.match(text, /### Files written \(2\)/u);
        assert.match(text, /^- Write, Edit, Bash `\/w\/a\.md`$/mu);
        assert.match(text, /^- Edit `\/w\/b\.js`$/mu);
    });

    // A live 0.11.3 handoff listed `Bash test/cli.test.ts` as written: the
    // command was a script writing test cases, and one case was a string
    // holding `open('test/cli.test.ts','w')`.
    for (const command of [
        "python3 - <<'EOF'\ncases = [\"open('test/cli.test.ts','w').write(s)\"]\nEOF",
        "python3 - <<'EOF'\ns = '''x'''\n    \"python3 - <<'EOF'\\np='x'\\nopen('test/cli.test.ts','w').write(s)\\nEOF\",\nEOF",
    ]) {
        it(`does not read a write out of a string the script only holds: ${JSON.stringify(command.slice(0, 40))}`, () => {
            assert.deepEqual(shellWrites(command), []);
        });
    }

    for (const [command, written] of [
        ["python3 -c \"open('/tmp/x.json','w').write('{}')\"", ["/tmp/x.json"]],
        ["node -e \"require('fs'); open('/tmp/n.txt','w')\"", ["/tmp/n.txt"]],
        ["sed -i 's/x/y/' hooks/module.js && bun test > /tmp/ch.log 2>&1", ["hooks/module.js"]],
        ["cat > /tmp/hookprobe/dump.sh <<EOF\necho hi\nEOF", ["/tmp/hookprobe/dump.sh"]],
        ["cp hooks/restore.js /tmp/restore.bak && sed -i 's/a/b/' hooks/restore.js", ["/tmp/restore.bak", "hooks/restore.js"]],
        ["python3 - <<'EOF'\nopen('test/cli.test.ts','w').write(s)\nEOF", ["test/cli.test.ts"]],
        ["echo hi | tee notes/out.md", ["notes/out.md"]],
        ["echo hi >> /w/log.txt", ["/w/log.txt"]],
        ['mv "$f" "$Q/$f"', []],
        ['git commit -m "x > y.md"', []],
        // A live 0.11.4 handoff listed `Bash test/cli.test.ts` off a PR body:
        // prose in a `cat` heredoc quoting the Python that wrote it.
        ["{ intent mark 2 --source op:x; cat <<'EOF'\nFixed: `open('test/cli.test.ts','w')` in a string\nEOF\n} > /tmp/body.md", ["/tmp/body.md"]],
        ["cat <<'EOF' | gh pr create --body-file -\nopen('test/cli.test.ts','w')\nEOF", []],
        ["node <<'EOF'\nconst fs = require('fs'); open('/tmp/n2.txt','w')\nEOF", ["/tmp/n2.txt"]],
        ["ls /tmp 2>/dev/null && echo done 2>&1", []],
    ]) {
        it(`reads ${JSON.stringify(written)} off ${JSON.stringify(command.slice(0, 50))}`, () => {
            assert.deepEqual(shellWrites(command), written);
        });
    }
});

describe("a file named relatively by the shell and absolutely by an edit is one file", () => {
    const ledgerOf = (commands, edits) =>
        renderLedger(
            ledgerRows([
                assistantTurn("x", [
                    ...edits.map((path) => use270("Edit", { file_path: path, old_string: "a", new_string: "b" }, { text: "ok" })),
                    ...commands.map((command) => use270("Bash", { command }, { text: "" })),
                ]),
            ]),
        );

    // A live 0.11.4 handoff listed `Bash hooks/lib.js` and the absolute Edit
    // path of the same file as two files written.
    it("folds the relative path into its one absolute twin", () => {
        const text = ledgerOf(["git show HEAD:hooks/lib.js > hooks/lib.js"], ["/w/repo/hooks/lib.js"]);

        assert.match(text, /1 file written\./u);
        assert.match(text, /^- Edit, Bash `\/w\/repo\/hooks\/lib\.js`$/mu);
    });

    it("keeps a relative path that has no twin, or more than one", () => {
        const alone = ledgerOf(["sed -i 's/a/b/' notes/x.md"], ["/w/repo/hooks/lib.js"]);
        const ambiguous = ledgerOf(["sed -i 's/a/b/' hooks/lib.js"], ["/w/a/hooks/lib.js", "/w/b/hooks/lib.js"]);

        assert.match(alone, /2 files written\./u);
        assert.match(ambiguous, /3 files written\./u);
        assert.match(ambiguous, /^- Bash `hooks\/lib\.js`$/mu);
    });

    it("does not fold a path that only ends in the same letters", () => {
        const text = ledgerOf(["sed -i 's/a/b/' lib.js"], ["/w/repo/hooks/mylib.js"]);

        assert.match(text, /2 files written\./u);
    });
});

describe("a command that only looked", () => {
    for (const command of [
        "git -C /w fetch -q; git diff --stat",
        "sed 's/a/b/' /tmp/x.log | grep -E '(pass|fail)'",
        "ls /tmp && echo hi 2>/dev/null",
        'echo "PWD=$(pwd) BRANCH=$(git rev-parse --abbrev-ref HEAD)"',
        "gh pr view 20 --json state",
        "cd /w && sed -n 1,20p hooks/lib.js",
    ]) {
        it(`is read-only: ${command.slice(0, 50)}`, () => {
            assert.equal(isReadOnlyCommand(command), true);
        });
    }

    for (const command of [
        "sed -i 's/a/b/' hooks/lib.js",
        "gh api -X DELETE repos/o/r/git/refs/heads/b",
        'mv "$f" "$Q/$f"',
        'git commit -m "x > y.md"',
        "bun test > /tmp/x.out",
        "git push origin fix",
        "rm -rf /w/old",
    ]) {
        it(`changed something: ${command.slice(0, 50)}`, () => {
            assert.equal(isReadOnlyCommand(command), false);
        });
    }
});

describe("a history read is logged against its session", () => {
    it("records the tool, the arguments and what the text costs the window", () => {
        const row = lookupRecord({
            at: "2026-09-15T03:40:00.000Z",
            sessionId: "abc",
            tool: "handoff_lookup",
            args: { n: 3, section: "summary" },
            text: "one\ntwo\nthree",
        });

        assert.deepEqual(row, {
            at: "2026-09-15T03:40:00.000Z",
            sessionId: "abc",
            tool: "handoff_lookup",
            args: { n: 3, section: "summary" },
            chars: 13,
            lines: 3,
            approxTokens: 4,
        });
    });

    it("names an unknown session rather than dropping the row", () => {
        assert.equal(lookupRecord({ at: "t", sessionId: null, tool: "handoff_search", text: "" }).sessionId, "unknown");
        assert.equal(lookupRecord({ at: "t", sessionId: null, tool: "handoff_search", text: "" }).lines, 0);
    });

    it("estimates four characters per token and says so in the field name", () => {
        assert.equal(approxTokens("x".repeat(4000)), 1000);
        assert.equal(approxTokens("x".repeat(4001)), 1001);
    });
});

describe("the commitments pass", () => {
    it("parses the three kinds and drops a NONE row", () => {
        const found = commitmentsFrom(
            [
                "UNKEPT | T12 | I will check /tmp/x next | no read of that path appears after",
                "CORRECTED | T20 | the test passes | later says it never ran",
                "UNANSWERED | T4 | which branch? | the user never replied",
                "UNKEPT | T99 | NONE | nothing found",
                "some prose that is not a row",
            ].join("\n"),
        );

        assert.equal(found.length, 3);
        assert.deepEqual(
            found.map((row) => row.kind),
            ["unkept", "corrected", "unanswered"],
        );
        assert.equal(found[0].turn, 12);
    });

    it("strips the quotes a model wraps the quote in", () => {
        const [row] = commitmentsFrom('UNKEPT | T1 | "I will check X" | no evidence');

        assert.equal(row.quote, "I will check X");
    });

    // A live 0.11.0 handoff listed one question to the user twice, once as an
    // unkept promise and once as unanswered, so a reader counted four owed
    // items where there were two.
    it("reports one finding once, under the most specific kind", () => {
        const found = commitmentsFrom(
            [
                'UNKEPT | T84 | "Should I quarantine them, delete them, or leave them?" | decision still owed',
                'UNANSWERED | T84 | "Should I quarantine them, delete them, or leave them?" | never chosen',
                'UNKEPT | T90 | "I will read the newest row" | not read yet',
            ].join("\n"),
        );

        assert.deepEqual(
            found.map((row) => [row.kind, row.quote]),
            [
                ["unanswered", "Should I quarantine them, delete them, or leave them?"],
                ["unkept", "I will read the newest row"],
            ],
        );
    });

    it("treats quotes that differ only in case, spacing or trailing punctuation as one", () => {
        const found = commitmentsFrom(
            ["UNKEPT | T1 | I will check X. | a", "UNKEPT | T2 | i will  check x | b"].join("\n"),
        );

        assert.equal(found.length, 1);
    });

    it("returns nothing for an empty or absent reply", () => {
        assert.deepEqual(commitmentsFrom(""), []);
        assert.deepEqual(commitmentsFrom(undefined), []);
    });

    it("renders nothing at all when the pass found nothing", () => {
        assert.equal(renderCommitments([]), "");
    });

    it("renders each kind under its own heading, with counts", () => {
        const text = renderCommitments(commitmentsFrom("UNKEPT | T1 | did not do it | no evidence"));

        assert.match(text, /## Commitments and open questions/u);
        assert.match(text, /### Said it would, no evidence it did \(1\)/u);
        assert.match(text, /judgement rather than a/u);
    });
});

describe("what the commitments pass is shown", () => {
    it("indexes every tool call by turn, with no results", () => {
        const index = toolIndex(mixedConversation(use270));

        assert.match(index, /^T1 \| Read \| \/repo\/src\/a\.ts$/mu);
        assert.match(index, /^T3 \| Bash \| npm run check$/mu);
        assert.doesNotMatch(index, /All checks passed/u);
    });

    it("shows the assistant's turns and not the user's", () => {
        const text = assistantTurns([userTurn("SECRET USER TEXT"), assistantTurn("I will check X")]);

        assert.match(text, /I will check X/u);
        assert.doesNotMatch(text, /SECRET USER TEXT/u);
    });

    it("says so in the prompt when it drops turns for length", () => {
        const many = Array.from({ length: 200 }, (_, i) => assistantTurn(`turn ${i} ${"y".repeat(5000)}`));
        const text = assistantTurns(many);

        assert.match(text, /earlier turns omitted for length/u);
        assert.match(text, /turn 199/u);
    });

    it("handles a conversation with nothing in it", () => {
        assert.equal(assistantTurns([]), "");
        assert.equal(toolIndex([]), "");
    });
});

describe("cost", () => {
    it("prices Sonnet 5 at its own rate, not the Sonnet family rate", () => {
        assert.equal(priceRowFor("claude-sonnet-5").input, 2);
        assert.equal(priceRowFor("claude-sonnet-4-6").input, 3);
    });

    it("prices Opus 5 at $5, not the retired Opus 4.1 $15", () => {
        assert.equal(priceRowFor("claude-opus-5").input, 5);
        assert.equal(priceRowFor("claude-opus-4-1").input, 15);
    });

    it("computes a real fork's cost off its four token counts", () => {
        const usage = {
            input_tokens: 1997,
            output_tokens: 1581,
            cache_read_input_tokens: 54_703,
            cache_creation_input_tokens: 75,
        };
        const priced = priceUsage(usage, "claude-opus-5");

        // 1997*5 + 1581*25 + 75*6.25, all per MTok; the 54703 cache reads are free.
        assert.ok(Math.abs(priced.usd - 0.0500) < 0.0005, `got ${priced.usd}`);
        assert.equal(priced.reason, null);
    });

    it("stores the cache reads and what they would have cost at list, without charging them", () => {
        const priced = priceUsage({ input_tokens: 0, cache_read_input_tokens: 1_000_000 }, "claude-opus-5");

        assert.equal(priced.usd, 0);
        assert.equal(priced.tokens.cacheRead, 1_000_000);
        assert.equal(priced.cacheReadWaivedUsd, 0.5);
    });

    it("refuses to price an unknown model rather than calling it free", () => {
        const priced = priceUsage({ input_tokens: 100 }, "some-other-model");

        assert.equal(priced.usd, null);
        assert.match(priced.reason, /no price for model/u);
    });

    it("refuses to price a result that carried no usage", () => {
        assert.equal(priceUsage(null, "claude-opus-5").usd, null);
        assert.equal(priceUsage(undefined, "claude-opus-5").usd, null);
    });

    it("sums the fork and the commitments pass", () => {
        const { cost } = costOf({
            forkUsage: { input_tokens: 1_000_000 },
            forkModel: "claude-opus-5",
            commitmentsUsd: 0.09,
        });

        assert.equal(cost.forkUsd, 5);
        assert.equal(cost.commitmentsUsd, 0.09);
        assert.equal(cost.totalUsd, 5.09);
        assert.equal(cost.pricesTaken, "2026-09-14");
        assert.equal(cost.cacheReadWaivedUsd, 0);
        assert.equal(cost.basis, "subscription: cache reads free");
    });

    it("keeps the fork's cache reads out of the total and says how much was waived", () => {
        const { cost } = costOf({
            forkUsage: { input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000 },
            forkModel: "claude-opus-5",
            commitmentsUsd: 0,
        });

        assert.equal(cost.forkUsd, 5);
        assert.equal(cost.totalUsd, 5);
        assert.equal(cost.forkUsage.cacheRead, 2_000_000);
        assert.equal(cost.cacheReadWaivedUsd, 1);
    });

    it("reports an unknown cost as null with a reason, never as zero", () => {
        const out = costOf({ forkUsage: null, forkModel: "claude-opus-5", commitmentsUsd: 0.09 });

        assert.equal(out.cost, null);
        assert.match(out.costUnknownReason, /no usage/u);
    });

    it("counts the commitments pass as zero only when it genuinely did not run", () => {
        const { cost } = costOf({ forkUsage: { input_tokens: 0 }, forkModel: "claude-opus-5" });

        assert.equal(cost.commitmentsUsd, 0);
        assert.equal(cost.totalUsd, 0);
    });
});

describe("summarisePrs", () => {
    it("marks the PR on this branch", () => {
        const text = summarisePrs(
            JSON.stringify([
                { number: 647, headRefName: "wt", title: "mine" },
                { number: 12, headRefName: "other", title: "theirs" },
            ]),
            "wt",
        );

        assert.equal(text, "#647 mine (this branch); #12 theirs");
    });

    // A handoff listed "#992" with no title; the next session read it as its own PR.
    it("names each PR by its title so one from another session is recognisable", () => {
        const text = summarisePrs(JSON.stringify([{ number: 992, headRefName: "issue-984", title: "changelog-cd: page big releases" }]), "main");

        assert.equal(text, "#992 changelog-cd: page big releases");
    });

    it("keeps a title from breaking the table it sits in", () => {
        const long = `a | b ${"x".repeat(200)}`;
        const text = summarisePrs(JSON.stringify([{ number: 1, headRefName: "h", title: long }]), "main");

        assert.ok(!text.includes("|"));
        assert.ok(text.length < 100);
    });

    it("says so when nothing is open", () => {
        assert.equal(summarisePrs("[]", "wt"), "none open");
    });

    it("returns null rather than throwing on output that is not JSON", () => {
        assert.equal(summarisePrs("gh: command not found", "wt"), null);
    });
});

describe("reading one section of a stored handoff", () => {
    const handoff = [
        "<!-- compact-handoff: session=s n=1 prev=none -->",
        "",
        "## What happened",
        "",
        "The summary.",
        "",
        "## Tool ledger",
        "",
        "23 tool calls.",
        "",
        "### Every shell command, in order",
        "",
        "- `npm test`",
        "",
        "## Session state, read live at compaction",
        "",
        "| branch | `wt` |",
    ].join("\n");

    it("stops at the next section, not at the next heading of any depth", () => {
        const ledger = sectionOf(handoff, "ledger");

        assert.match(ledger, /### Every shell command/u);
        assert.doesNotMatch(ledger, /Session state/u);
    });

    it("finds a section whose heading carries a suffix", () => {
        assert.match(sectionOf(handoff, "state"), /\| branch \| `wt` \|/u);
    });

    it("is null for a section the handoff does not have, and for a name it does not know", () => {
        assert.equal(sectionOf(handoff, "commitments"), null);
        assert.equal(sectionOf(handoff, "everything"), null);
    });
});

describe("what the conversation had already done", () => {
    it("keeps the command as typed, not as the ledger clips it", () => {
        const long = `git log --oneline ${"-x".repeat(200)}`;
        const { commands } = workDone([assistantTurn("", [use270("Bash", { command: long })])]);

        assert.deepEqual(commands, [long]);
    });

    it("counts a whole-file read and not a paged one", () => {
        const { reads } = workDone([
            assistantTurn("", [
                use270("Read", { file_path: "/repo/a.ts" }),
                use270("Read", { file_path: "/repo/b.ts", offset: 100, limit: 50 }),
            ]),
        ]);

        assert.deepEqual(reads, ["/repo/a.ts"]);
    });
});

describe("watching what the session did after a compaction", () => {
    const marker = (n) => lineageLine({ session: "s", n, prev: n === 1 ? null : n - 1 });
    // Everything before the compaction: an earlier window's work, which
    // `$.session.messages()` still returns.
    const before = [
        userTurn("Fix the build."),
        assistantTurn("", [use270("Bash", { command: "npm test" }), use270("Read", { file_path: "/repo/a.ts" })]),
        userTurn("And the docs."),
        assistantTurn("", [use270("Bash", { command: "npm run docs" })]),
    ];
    // What a replaced compaction puts in: the handoff, then two pinned turns.
    const replacement = [assistantTurn(`${marker(1)}\n\nThe handoff.`), userTurn("Fix the build."), userTurn("And the docs.")];
    const seed = (extra = {}) =>
        monitorSeed({
            session: "s",
            n: 1,
            at: "2026-09-14T00:00:00.000Z",
            kind: "handoff",
            ordinal: 0,
            from: replacement.length,
            messages: before,
            ...extra,
        });
    const whole = (...after) => [...before, ...replacement, ...after];

    // Through 0.11.4 the watch sliced the whole session from the replacement's
    // length, so every earlier turn read as new work: 510 to 894 "turns",
    // 32 to 63 re-run commands and an empty first message on every live file.
    it("watches only what came after the replacement, in a transcript holding every window", () => {
        const observed = observePost(
            seed(),
            whole(
                userTurn("Carry on."),
                assistantTurn("", [
                    use270("Bash", { command: "npm test" }),
                    use270("Read", { file_path: "/repo/a.ts" }),
                    use270("Bash", { command: "npm run build" }),
                ]),
            ),
        );

        assert.equal(observed.anchored, true);
        assert.equal(observed.turnsObserved, 1);
        assert.equal(observed.firstUserMessage, "Carry on.");
        assert.deepEqual(observed.reRunCommands, ["npm test"]);
        assert.deepEqual(observed.reReadFiles, ["/repo/a.ts"]);
        assert.equal(observed.turnsToFirstToolCall, 1);
        assert.equal(observed.done, false);
    });

    it("counts turns the person typed, not tool results or the harness", () => {
        const observed = observePost(
            seed(),
            whole(crossSessionTurn(), userTurn("Carry on."), assistantTurn("", [use270("Bash", { command: "ls" })]), toolResultTurn()),
        );

        assert.equal(observed.firstUserMessage, "Carry on.");
        assert.equal(observed.turnsObserved, 1);
    });

    it("says the session reached for a tool before anyone spoke", () => {
        const observed = observePost(seed(), whole(assistantTurn("", [use270("Bash", { command: "git status" })])));

        assert.equal(observed.turnsToFirstToolCall, 0);
        assert.equal(observed.firstUserMessage, null);
    });

    it("records which handoff tool the session reached for, and keeps watching after it read one", () => {
        const lookup = { ...toolResultTurn(), text: `${marker(1)}\n\nThe handoff, read back.` };
        const observed = observePost(
            seed(),
            whole(assistantTurn("", [use270("mcp__compact-handoff__handoff_lookup", { section: "ledger" })]), lookup),
        );

        assert.deepEqual(observed.handoffToolsCalled, ["mcp__compact-handoff__handoff_lookup"]);
        assert.equal(observed.compactedAgain, false);
        assert.equal(observed.done, false);
    });

    it("stops watching when the conversation compacts again", () => {
        const observed = observePost(seed(), whole(userTurn("go"), assistantTurn(`${marker(2)}\n\nThe next handoff.`)));

        assert.equal(observed.compactedAgain, true);
        assert.equal(observed.done, true);
    });

    it("stops, unanchored, when the transcript does not hold the handoff it was armed for", () => {
        const observed = observePost(seed(), [...before, userTurn("Carry on.")]);

        assert.equal(observed.anchored, false);
        assert.equal(observed.turnsObserved, 0);
        assert.equal(observed.done, true);
    });

    it("stops watching after ten person turns, and not before", () => {
        const turns = (n) => whole(...Array.from({ length: n }, (_, i) => userTurn(`turn ${i}`)));

        assert.equal(observePost(seed(), turns(9)).done, false);
        assert.equal(observePost(seed(), turns(10)).done, true);
    });

    // The engine's own compaction is the baseline: the same watch, anchored on
    // its continuation summary rather than a handoff.
    it("watches a stock compaction from its continuation summary", () => {
        const stock = [continuationTurn(), userTurn("Fix the build.")];
        const observed = observePost(seed({ kind: "stock", ordinal: 0, from: stock.length }), [
            ...before,
            ...stock,
            userTurn("Carry on."),
            assistantTurn("", [use270("Bash", { command: "npm run docs" })]),
        ]);

        assert.equal(observed.kind, "stock");
        assert.equal(observed.anchored, true);
        assert.equal(observed.turnsObserved, 1);
        assert.deepEqual(observed.reRunCommands, ["npm run docs"]);
    });

    it("finds the window it watches past earlier compactions of either kind", () => {
        const earlier = [assistantTurn(`${marker(1)}\n\nold`), continuationTurn()];
        const observed = observePost(seed({ n: 2, ordinal: 2, from: 2 }), [
            ...earlier,
            ...before,
            assistantTurn(`${marker(2)}\n\nThe handoff.`),
            userTurn("pinned"),
            userTurn("Carry on."),
        ]);

        assert.deepEqual(
            openersIn([...earlier, assistantTurn(marker(2))]).map(({ kind, n }) => [kind, n]),
            [
                ["handoff", 1],
                ["stock", 2],
                ["handoff", 2],
            ],
        );
        assert.equal(observed.anchored, true);
        assert.equal(observed.firstUserMessage, "Carry on.");
    });
});

describe("why a compaction was not replaced", () => {
    it("says nothing at all when the handoff did go up", () => {
        assert.equal(fallbackReasonFor({ outcome: "handoff" }, "replaced"), null);
    });

    it("names the subagent pass-through and the switch that opts in", () => {
        const reason = fallbackReasonFor({ outcome: "subagent" }, "passedThrough");

        assert.match(reason, /^subagent:/u);
        assert.match(reason, /COMPACT_HANDOFF_SUBAGENTS/u);
    });

    it("distinguishes a rehearsal from a real fallback", () => {
        assert.match(fallbackReasonFor({}, "rehearsed"), /^rehearsal:.*COMPACT_HANDOFF_LIVE/u);
    });

    it("says the engine gave up when the signal aborted", () => {
        assert.match(fallbackReasonFor({ aborted: true }, "abortedFallback"), /^aborted:/u);
    });

    it("folds the outcome, the detail and the fork into one readable line", () => {
        assert.equal(
            fallbackReasonFor(
                {
                    outcome: "noHandoff",
                    detail: "no handoff has been written yet",
                    forkOutcome: "cold",
                    forkDetail: "the fork found no warm main-thread transcript",
                },
                "fellBack",
            ),
            "noHandoff: no handoff has been written yet (fork cold: the fork found no warm main-thread transcript)",
        );
    });

    it("still answers when the row carries nothing but a disposition", () => {
        assert.equal(fallbackReasonFor({}, "fellBack"), "unknown");
    });
});

describe("a run that made no model call", () => {
    it("costs zero rather than being unpriced", () => {
        const { cost, costNote } = costOfNothing("claude-haiku-4-5-20251001", "no model call was made");

        assert.equal(cost.totalUsd, 0);
        assert.equal(cost.forkUsd, 0);
        assert.equal(cost.forkUsage, null);
        assert.equal(cost.model, "claude-haiku-4-5-20251001");
        assert.equal(costNote, "no model call was made");
    });

    it("is not the same shape as an unpriceable run, which stays null", () => {
        assert.equal(costOf({ forkUsage: null, forkModel: "x", commitmentsUsd: 0 }).cost, null);
    });
});

describe("the commitments pass is priced off an estimate", () => {
    it("counts four characters a token, rounded up, with no cache", () => {
        assert.deepEqual(estimatedUsage(10, 0), { input_tokens: 3, output_tokens: 0 });
        assert.deepEqual(estimatedUsage(12_569, 1_000), { input_tokens: 3143, output_tokens: 250 });
    });

    it("prices the estimate at the model's own rate through priceUsage", () => {
        const priced = priceUsage(estimatedUsage(4_000_000, 1_000_000), "claude-sonnet-5");

        assert.equal(priced.usd, 1_000_000 * 2 / 1_000_000 + 250_000 * 10 / 1_000_000);
        assert.equal(priced.priced, "Sonnet 5");
    });

    it("carries the basis of the commitments number into the cost row", () => {
        const { cost } = costOf({
            forkUsage: { input_tokens: 1000 },
            forkModel: "claude-opus-5",
            commitmentsUsd: 0.01,
            commitmentsBasis: "estimate: chars/4, no cache",
        });

        assert.equal(cost.commitmentsUsd, 0.01);
        assert.equal(cost.commitmentsBasis, "estimate: chars/4, no cache");
    });

    it("says none when no commitments pass ran, never an unlabelled zero", () => {
        const { cost } = costOf({ forkUsage: { input_tokens: 1000 }, forkModel: "claude-opus-5", commitmentsUsd: 0 });

        assert.equal(cost.commitmentsUsd, 0);
        assert.equal(cost.commitmentsBasis, "none");
    });
});

describe("whether a subagent ran this turn", () => {
    it("sees an Agent call after the last typed turn", () => {
        const messages = [
            userTurn("earlier"),
            assistantTurn("", [use270("Agent", { prompt: "x" })]),
            userTurn("now"),
            assistantTurn("", [use270("Agent", { prompt: "y" })]),
        ];

        assert.equal(subagentRanThisTurn(messages), true);
    });

    it("ignores an Agent call from a previous turn", () => {
        const messages = [
            userTurn("earlier"),
            assistantTurn("", [use270("Task", { prompt: "x" })]),
            userTurn("now"),
            assistantTurn("", [use270("Read", { file_path: "a" })]),
        ];

        assert.equal(subagentRanThisTurn(messages), false);
    });

    it("does not count a tool result carrier as the start of a turn", () => {
        const messages = [
            userTurn("now"),
            assistantTurn("", [use270("Agent", { prompt: "x" })]),
            toolResultTurn(),
            assistantTurn("done"),
        ];

        assert.equal(subagentRanThisTurn(messages), true);
    });

    it("is false on an empty transcript", () => {
        assert.equal(subagentRanThisTurn([]), false);
    });
});

describe("the handoff ceiling", () => {
    it("is a quarter of a 200k window, in characters", () => {
        const out = handoffCeiling({ window: 200_000 });

        assert.equal(out.chars, 200_000);
        assert.equal(out.decider, "fraction");
        assert.equal(out.fraction, 0.25);
        assert.equal(out.capTokens, 150_000);
        assert.equal(out.window, 200_000);
    });

    it("caps a 1M window at 150k tokens", () => {
        const out = handoffCeiling({ window: 1_000_000 });

        assert.equal(out.chars, 600_000);
        assert.equal(out.decider, "cap");
    });

    it("clamps the tokens setting at 200k", () => {
        const out = handoffCeiling({ window: 1_000_000, capTokens: 500_000 });

        assert.equal(out.capTokens, 200_000);
        assert.equal(out.chars, 800_000);
    });

    it("honours a smaller fraction", () => {
        const out = handoffCeiling({ window: 200_000, fraction: 0.1 });

        assert.equal(out.chars, 80_000);
    });

    it("falls back to the default when the window is unknown", () => {
        const out = handoffCeiling({ window: null });

        assert.equal(out.chars, 400_000);
        assert.equal(out.window, null);
        assert.equal(out.decider, "default: window unknown");
    });

    it("lets a hand-set override win, unclamped, and flags the overrun", () => {
        const out = handoffCeiling({ window: 200_000, override: 1_000_000 });

        assert.equal(out.chars, 1_000_000);
        assert.equal(out.decider, "override");
        assert.equal(out.overSafeCapChars, 200_000);
        assert.equal(out.overSafeCapTokens, 50_000);
    });

    it("does not flag an override inside the safe cap", () => {
        const out = handoffCeiling({ window: 200_000, override: 300_000 });

        assert.equal(out.chars, 300_000);
        assert.equal(out.decider, "override");
        assert.equal("overSafeCapChars" in out, false);
    });

    it("ignores unusable settings", () => {
        const out = handoffCeiling({ window: 200_000, fraction: Number.NaN, capTokens: -1, override: 0 });

        assert.equal(out.chars, 200_000);
        assert.equal(out.decider, "fraction");
    });
});

describe("one window occupancy reading", () => {
    const context = { tokens: 60_000, window: 200_000, percent: 30 };

    it("calls a window with no handoff in it a fresh one", () => {
        const row = windowReading({ at: "now", session: "s", turn: 1, context, messages: 4, opener: null });

        assert.equal(row.phase, "fresh");
        assert.equal(row.compaction, 0);
        assert.equal(row.percent, 30);
        assert.equal(row.first, true);
        assert.equal(row.handoffTokens, null);
        assert.equal(row.handoffPercent, null);
    });

    it("says how much of a post-compact window the handoff itself is", () => {
        const row = windowReading({
            at: "now",
            session: "s",
            turn: 3,
            context,
            messages: 9,
            opener: { kind: "handoff", n: 6, chars: 24_000 },
        });

        assert.equal(row.phase, "post-compact");
        assert.equal(row.compaction, 6);
        assert.equal(row.handoffTokens, 6000);
        assert.equal(row.handoffPercent, 3);
        assert.equal(row.first, false);
    });

    it("tells a window the engine compacted apart from one this plugin did", () => {
        const row = windowReading({
            at: "now",
            session: "s",
            turn: 1,
            context,
            messages: 9,
            opener: { kind: "stock", n: 1, chars: 8_000 },
        });

        assert.equal(row.phase, "stock-compact");
        assert.equal(row.handoffChars, 8_000);
        assert.equal(row.first, true);
    });

    it("reports a percent to one decimal rather than the engine's rounding", () => {
        const row = windowReading({
            at: "now",
            session: "s",
            turn: 1,
            context: { tokens: 12_345, window: 200_000, percent: 6 },
            messages: 2,
            opener: null,
        });

        assert.equal(row.percent, 6.2);
    });

    it("falls back to the engine's own percent when there is no window to divide by", () => {
        const row = windowReading({
            at: "now",
            session: "s",
            turn: 1,
            context: { percent: 41 },
            messages: 2,
            opener: null,
        });

        assert.equal(row.tokens, null);
        assert.equal(row.window, null);
        assert.equal(row.percent, 41);
    });

    it("reads nothing at all rather than throwing when usage is unavailable", () => {
        const row = windowReading({ at: "now", session: "s", turn: 1, context: null, messages: 2, opener: null });

        assert.equal(row.percent, null);
        assert.equal(row.phase, "fresh");
    });
});

describe("the summariser's scratchpad", () => {
    it("drops the analysis block and unwraps the summary", () => {
        const dropped = withoutScratchpad(
            "<analysis>\nLet me work through this.\nWait, no.\n</analysis>\n\n<summary>\n1. Primary Request\n</summary>",
        );

        assert.equal(dropped.text, "1. Primary Request");
        assert.equal(dropped.analysisChars, 37);
        assert.equal(dropped.unwrapped, true);
    });

    it("keeps a reply that has neither tag exactly as it came", () => {
        const dropped = withoutScratchpad("1. Primary Request\n\n2. Key Technical Concepts");

        assert.equal(dropped.text, "1. Primary Request\n\n2. Key Technical Concepts");
        assert.equal(dropped.analysisChars, 0);
        assert.equal(dropped.unwrapped, false);
    });

    it("keeps what a model wrote after the closing summary tag", () => {
        const dropped = withoutScratchpad("<summary>\n9. Next Step\n</summary>\n\n10. Work ledger\n");

        assert.equal(dropped.text, "9. Next Step\n\n10. Work ledger");
    });

    it("drops every analysis block when the model writes more than one", () => {
        const dropped = withoutScratchpad("<analysis>one</analysis>\nA\n<analysis>two</analysis>\nB");

        assert.equal(dropped.text, "A\nB");
        assert.equal(dropped.analysisChars, 6);
    });

    /**
     * A reply cut off inside the scratchpad has no summary to keep. Dropping to
     * the end of the text would hand the next window nothing, so an unclosed
     * block with no summary after it is left alone and the row says so.
     */
    it("leaves an unclosed analysis alone rather than dropping the whole reply", () => {
        const dropped = withoutScratchpad("<analysis>\nLet me work through this and then the reply was cut");

        assert.equal(dropped.text, "<analysis>\nLet me work through this and then the reply was cut");
        assert.equal(dropped.analysisChars, 0);
    });

    it("drops an unclosed analysis when a summary follows it anyway", () => {
        const dropped = withoutScratchpad("<analysis>\nthinking\n\n<summary>\n1. Primary Request\n</summary>");

        assert.equal(dropped.text, "1. Primary Request");
        assert.ok(dropped.analysisChars > 0, `got ${dropped.analysisChars}`);
    });

    it("keeps a preamble written before the analysis", () => {
        const dropped = withoutScratchpad("Here is the summary.\n<analysis>x</analysis>\n<summary>1.</summary>");

        assert.equal(dropped.text, "Here is the summary.\n1.");
    });
});

describe("the commitments reply against its output cap", () => {
    const row = (n) => `UNKEPT | T${n} | "quote ${n}" | note ${n}`;

    it("counts the rows and reports no cap on a short, well-formed reply", () => {
        const out = commitmentsOutcome([row(1), row(2)].join("\n"), 8192);

        assert.equal(out.rows, 2);
        assert.equal(out.hitCap, false);
        assert.equal(out.hitCapReason, null);
    });

    it("reports the cap when the reply runs near the ceiling", () => {
        const text = Array.from({ length: 2000 }, (_, i) => row(i)).join("\n");
        const out = commitmentsOutcome(text, 8192);

        assert.equal(out.hitCap, true);
        assert.equal(out.hitCapReason, "length");
    });

    it("reports the cap when the final row is cut mid-shape", () => {
        const out = commitmentsOutcome([row(1), 'CORRECTED | T7 | "cut off he'].join("\n"), 8192);

        assert.equal(out.rows, 1);
        assert.equal(out.hitCap, true);
        assert.equal(out.hitCapReason, "truncated row");
    });

    it("does not mistake a trailing prose line for a truncated row", () => {
        const out = commitmentsOutcome([row(1), "That is everything."].join("\n"), 8192);

        assert.equal(out.hitCap, false);
    });

    it("is quiet on an empty reply", () => {
        const out = commitmentsOutcome("", 8192);

        assert.deepEqual(out, { rows: 0, hitCap: false, hitCapReason: null });
    });
});

describe("what a fork was charged to read, against the session it forked from", () => {
    // Both rows are real, off `usage` and `forkContext.context` in
    // `~/.claude/compact-handoff/index.jsonl`: the cold one 2026-09-16T17:35Z,
    // the warm one 2026-09-16T18:30Z. Across the 24 rows carrying both
    // readings the split is clean: every cold fork is at or below 0.47 of its
    // context and every warm one at or above 1.01, with nothing between.
    const cold = { input_tokens: 46_387, output_tokens: 9909, cache_read_input_tokens: 18_705, cache_creation_input_tokens: 0 };
    const warm = { input_tokens: 2291, output_tokens: 1894, cache_read_input_tokens: 56_851, cache_creation_input_tokens: 0 };

    it("reads a cold fork as short of the context it should have carried", () => {
        const input = forkInputOf(cold, { tokens: 164_273, window: 200_000 });

        assert.equal(input.sent, 65_092);
        assert.equal(input.cacheRead, 18_705);
        assert.equal(input.contextTokens, 164_273);
        assert.equal(input.matchesContext, false);
    });

    it("reads a warm fork as carrying it", () => {
        const input = forkInputOf(warm, { tokens: 56_850, window: 200_000 });

        assert.equal(input.sent, 59_142);
        assert.equal(input.matchesContext, true);
    });

    it("calls an unknown an unknown rather than a mismatch", () => {
        assert.equal(forkInputOf(null, { tokens: 164_273 }).matchesContext, null);
        assert.equal(forkInputOf(cold, null).matchesContext, null);
        assert.equal(forkInputOf(cold, { tokens: 0 }).matchesContext, null);
    });
});
