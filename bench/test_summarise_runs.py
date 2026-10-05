"""The A/B report joins each compaction to its watch and its window.

    python3 -m unittest bench/test_summarise_runs.py
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(__file__))

import summarise_runs  # noqa: E402


def write_lines(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)

    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def t(second):
    return f"2026-09-28T00:00:{second:02d}.000Z"


class AbReport(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.rows = [
            self.compaction("H", "replaced", "handoff", handoffChars=20_000, cost=0.9),
            self.compaction("F", "fellBack", "handoff", cost=0.2),
            self.compaction("S", "abStock", "stock", stockSummaryChars=8_000, cost=0.4, post={"anchored": True, "kind": "stock", "reRunCommands": ["npm test", "ls"], "reReadFiles": [], "turnsToFirstToolCall": 0, "handoffToolsCalled": [], "compactedAgain": False}),
            self.compaction("X", "replaced", None),
            # S again after a resume: the recorded depth restarted at 1.
            self.compaction("S", "abStock", "stock", at=t(5), stem="002-t", stockSummaryChars=7_000, cost=0.3),
        ]
        write_lines(
            os.path.join(self.root, "window.jsonl"),
            [
                {"at": t(0), "session": "S", "turn": 1, "compaction": 0, "phase": "fresh", "arm": "stock", "tokens": 20_000},
                {"at": t(2), "session": "S", "turn": 1, "compaction": 1, "phase": "stock-compact", "arm": "stock", "tokens": 31_000},
                {"at": t(3), "session": "S", "turn": 2, "compaction": 1, "phase": "stock-compact", "arm": "stock", "tokens": 90_000},
                {"at": t(4), "session": "S", "turn": 3, "compaction": 1, "phase": "stock-compact", "arm": "stock", "tokens": 150_000},
                {"at": t(6), "session": "S", "turn": 1, "compaction": 1, "phase": "stock-compact", "arm": "stock", "tokens": 30_000},
                {"at": t(7), "session": "H", "turn": 1, "compaction": 1, "phase": "post-compact", "arm": "handoff", "tokens": 42_000},
            ],
        )

    def compaction(self, session, disposition, arm, cost=None, post=None, at=None, stem="001-t", ab=None, **extra):
        path = os.path.join(self.root, "sessions", session, stem)
        row = {
            "at": at or t(1),
            "sessionId": session,
            "agentId": None,
            "disposition": disposition,
            "depth": 1,
            "ab": None if arm is None else {"arm": arm, "share": 0.5, "bucket": 0.1, **(ab or {})},
            "cost": {"totalUsd": cost},
            "files": {".json": path + ".json"},
            **extra,
        }

        write_lines(path + ".json", [row])

        if post is not None:
            write_lines(path + ".post.json", [post])

        return row

    def stock_windows(self):
        return [r for r in summarise_runs.ab_rows(self.rows, self.root) if r["session"] == "S"]

    def test_groups_by_the_assigned_arm_so_a_fallback_counts_against_the_handoff(self):
        joined = summarise_runs.ab_rows(self.rows, self.root)

        self.assertEqual(
            [(r["session"], r["arm"], r["applied"]) for r in joined],
            [("H", "handoff", "handoff"), ("F", "handoff", "stock"), ("S", "stock", "stock"), ("S", "stock", "stock")],
        )

    def test_joins_the_watch_and_the_window_after_the_compaction(self):
        stock = self.stock_windows()[0]

        self.assertEqual(stock["summaryChars"], 8_000)
        self.assertEqual(stock["tokensAfterFirstTurn"], 31_000)
        self.assertEqual(stock["turnsInWindow"], 3)
        self.assertTrue(stock["windowClosed"])
        self.assertEqual(stock["reRan"], 2)

    # Issue #1098: a resumed session restarts its depth, so two windows share
    # (session, depth); joined on that, their turns merged into one window.
    def test_two_compactions_sharing_a_depth_get_two_windows(self):
        first, second = self.stock_windows()

        self.assertEqual((first["depth"], second["depth"]), (1, 1))
        self.assertEqual((first["turnsInWindow"], second["turnsInWindow"]), (3, 1))
        self.assertEqual((first["tokensAfterFirstTurn"], second["tokensAfterFirstTurn"]), (31_000, 30_000))

    def test_closes_a_window_only_when_a_later_compaction_of_the_session_exists(self):
        first, second = self.stock_windows()

        self.assertTrue(first["windowClosed"])
        self.assertFalse(second["windowClosed"])

    def test_leaves_an_open_window_and_an_unwatched_compaction_unmeasured(self):
        handoff = next(r for r in summarise_runs.ab_rows(self.rows, self.root) if r["session"] == "H")

        self.assertFalse(handoff["windowClosed"])
        self.assertFalse(handoff["watched"])
        self.assertIsNone(handoff["reRan"])

    def test_orders_two_compactions_in_one_clock_tick_by_file_stem(self):
        rows = [
            self.compaction("R", "abStock", "stock", at=t(1), stem="002-t"),
            self.compaction("R", "abStock", "stock", at=t(1), stem="001-t"),
        ]
        write_lines(os.path.join(self.root, "window.jsonl"), [{"at": t(2), "session": "R", "turn": 1, "tokens": 5_000}])

        joined = {os.path.basename(r["files"][".json"]): r for r in summarise_runs.ab_rows(rows, self.root)}

        self.assertEqual((joined["001-t.json"]["turnsInWindow"], joined["001-t.json"]["windowClosed"]), (0, True))
        self.assertEqual((joined["002-t.json"]["turnsInWindow"], joined["002-t.json"]["windowClosed"]), (1, False))

    def test_reads_a_row_without_a_design_as_the_session_design(self):
        self.rows.append(self.compaction("C", "replaced", "handoff", at=t(8), ab={"design": "compaction", "coin": 0.7, "priorArm": "stock", "handoffRun": 0, "runFrom": "store"}))

        designs = {r["session"]: r["design"] for r in summarise_runs.ab_rows(self.rows, self.root)}

        self.assertEqual(designs["S"], "session")
        self.assertEqual(designs["C"], "compaction")

    def test_prints_both_arms_split_by_design_and_warns_on_a_small_sample(self):
        self.rows.append(self.compaction("C", "replaced", "handoff", at=t(8), ab={"design": "compaction", "coin": 0.7, "priorArm": "stock", "handoffRun": 0, "runFrom": "store"}))
        out = io.StringIO()

        with redirect_stdout(out):
            summarise_runs.print_ab(self.rows, self.root)

        text = out.getvalue()
        compactions = next(line for line in text.splitlines() if line.strip().startswith("compactions"))

        self.assertIn("got its assigned arm", text)
        self.assertIn("2/3", text)
        self.assertIn("comp:handoff", text)
        # all:handoff, all:stock, sess:handoff, sess:stock, comp:handoff, comp:stock
        self.assertEqual(compactions.split()[1:], ["3", "2", "2", "2", "1", "-"])
        self.assertIn("by what the previous compaction left", text)
        self.assertIn("read any gap as noise", text)

    def test_exports_one_line_per_ab_compaction(self):
        path = os.path.join(self.root, "ab.jsonl")

        with redirect_stdout(io.StringIO()):
            summarise_runs.export_ab(self.rows, self.root, path)

        with open(path, encoding="utf-8") as handle:
            self.assertEqual(len(handle.readlines()), 4)


if __name__ == "__main__":
    unittest.main()
