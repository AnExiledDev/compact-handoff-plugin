import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    applySizeGuard,
    assistantTurns,
    commitmentsFrom,
    costOf,
    costOfNothing,
    fallbackReasonFor,
    isPinnable,
    ledgerRows,
    lineageLine,
    lineageOf,
    monitorSeed,
    nameOf,
    observePost,
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
    summarisePrs,
    targetOf,
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

            assert.match(text, /6 tool calls: 1 file write, 4 shell commands\./u);
            assert.match(text, /### Files written \(1 call\)/u);
            assert.match(text, /### Every shell command, in order \(4\)/u);
        });
    }

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

    it("hands the pinned turns back with their handle intact", () => {
        const out = replacementFor([userTurn("first")], "H");

        assert.equal(out[1].handle, "h-user");
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

        // 1997*5 + 1581*25 + 54703*0.5 + 75*6.25, all per MTok.
        assert.ok(Math.abs(priced.usd - 0.0770) < 0.0005, `got ${priced.usd}`);
        assert.equal(priced.reason, null);
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
        const text = summarisePrs(JSON.stringify([{ number: 647, headRefName: "wt" }, { number: 12, headRefName: "other" }]), "wt");

        assert.equal(text, "#647 (this branch), #12");
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

describe("watching what the session did with the handoff", () => {
    const before = [
        userTurn("Fix the build."),
        assistantTurn("", [
            use270("Bash", { command: "npm test" }),
            use270("Read", { file_path: "/repo/a.ts" }),
        ]),
    ];
    const seed = () => monitorSeed({ session: "s", n: 1, at: "2026-09-14T00:00:00.000Z", from: 2, messages: before });

    it("names the work the new conversation repeated", () => {
        const after = [
            ...before,
            userTurn("Carry on."),
            assistantTurn("", [
                use270("Bash", { command: "npm test" }),
                use270("Read", { file_path: "/repo/a.ts" }),
                use270("Bash", { command: "npm run build" }),
            ]),
        ];
        const observed = observePost(seed(), after);

        assert.deepEqual(observed.reRunCommands, ["npm test"]);
        assert.deepEqual(observed.reReadFiles, ["/repo/a.ts"]);
        assert.equal(observed.turnsToFirstToolCall, 1);
    });

    it("keeps the person's first words and skips the harness's", () => {
        const observed = observePost(seed(), [...before, crossSessionTurn(), userTurn("Carry on.")]);

        assert.equal(observed.firstUserMessage, "Carry on.");
        assert.equal(observed.turnsToFirstToolCall, null);
    });

    it("records which handoff tool the session reached for", () => {
        const observed = observePost(seed(), [
            ...before,
            assistantTurn("", [use270("mcp__compact-handoff__handoff_lookup", { section: "ledger" })]),
        ]);

        assert.deepEqual(observed.handoffToolsCalled, ["mcp__compact-handoff__handoff_lookup"]);
    });

    it("stops watching when the conversation compacts again", () => {
        const observed = observePost(seed(), [
            ...before,
            userTurn("<!-- compact-handoff: session=s n=2 prev=1 -->\n\nThe next handoff."),
        ]);

        assert.equal(observed.compactedAgain, true);
        assert.equal(observed.done, true);
    });

    it("stops watching after ten turns, and not before", () => {
        const turns = (n) => [...before, ...Array.from({ length: n }, () => assistantTurn("thinking"))];

        assert.equal(observePost(seed(), turns(9)).done, false);
        assert.equal(observePost(seed(), turns(10)).done, true);
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

    it("carries both numbers when the session ran out of budget", () => {
        assert.equal(
            fallbackReasonFor({ spentUsd: 10.5, ceilingUsd: 10 }, "overBudget"),
            "overBudget: $10.50 spent this session against a $10.00 ceiling",
        );
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
