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


class AbReport(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.rows = [
            self.compaction("H", "replaced", "handoff", handoffChars=20_000, cost=0.9),
            self.compaction("F", "fellBack", "handoff", cost=0.2),
            self.compaction("S", "abStock", "stock", stockSummaryChars=8_000, cost=0.4, post={"anchored": True, "kind": "stock", "reRunCommands": ["npm test", "ls"], "reReadFiles": [], "turnsToFirstToolCall": 0, "handoffToolsCalled": [], "compactedAgain": False}),
            self.compaction("X", "replaced", None),
        ]
        write_lines(
            os.path.join(self.root, "window.jsonl"),
            [
                {"at": "1", "session": "S", "turn": 1, "compaction": 0, "phase": "fresh", "arm": "stock", "tokens": 20_000},
                {"at": "2", "session": "S", "turn": 1, "compaction": 1, "phase": "stock-compact", "arm": "stock", "tokens": 31_000},
                {"at": "3", "session": "S", "turn": 2, "compaction": 1, "phase": "stock-compact", "arm": "stock", "tokens": 90_000},
                {"at": "4", "session": "S", "turn": 3, "compaction": 1, "phase": "stock-compact", "arm": "stock", "tokens": 150_000},
                {"at": "5", "session": "S", "turn": 1, "compaction": 2, "phase": "stock-compact", "arm": "stock", "tokens": 30_000},
                {"at": "6", "session": "H", "turn": 1, "compaction": 1, "phase": "post-compact", "arm": "handoff", "tokens": 42_000},
            ],
        )

    def compaction(self, session, disposition, arm, cost=None, post=None, **extra):
        stem = os.path.join(self.root, "sessions", session, "001-t")
        row = {
            "at": f"2026-09-28T00:00:0{len(session)}Z",
            "sessionId": session,
            "agentId": None,
            "disposition": disposition,
            "depth": 1,
            "ab": None if arm is None else {"arm": arm, "share": 0.5, "bucket": 0.1},
            "cost": {"totalUsd": cost},
            "files": {".json": stem + ".json"},
            **extra,
        }

        write_lines(stem + ".json", [row])

        if post is not None:
            write_lines(stem + ".post.json", [post])

        return row

    def test_groups_by_the_assigned_arm_so_a_fallback_counts_against_the_handoff(self):
        joined = summarise_runs.ab_rows(self.rows, self.root)

        self.assertEqual([(r["session"], r["arm"], r["applied"]) for r in joined], [("H", "handoff", "handoff"), ("F", "handoff", "stock"), ("S", "stock", "stock")])

    def test_joins_the_watch_and_the_window_after_the_compaction(self):
        stock = next(r for r in summarise_runs.ab_rows(self.rows, self.root) if r["session"] == "S")

        self.assertEqual(stock["summaryChars"], 8_000)
        self.assertEqual(stock["tokensAfterFirstTurn"], 31_000)
        self.assertEqual(stock["turnsInWindow"], 3)
        self.assertTrue(stock["windowClosed"])
        self.assertEqual(stock["reRan"], 2)

    def test_leaves_an_open_window_and_an_unwatched_compaction_unmeasured(self):
        handoff = next(r for r in summarise_runs.ab_rows(self.rows, self.root) if r["session"] == "H")

        self.assertFalse(handoff["windowClosed"])
        self.assertFalse(handoff["watched"])
        self.assertIsNone(handoff["reRan"])

    def test_prints_both_arms_and_warns_on_a_small_sample(self):
        out = io.StringIO()

        with redirect_stdout(out):
            summarise_runs.print_ab(self.rows, self.root)

        text = out.getvalue()

        self.assertIn("got its assigned arm", text)
        self.assertIn("1/2", text)
        self.assertIn("read any gap as noise", text)

    def test_exports_one_line_per_ab_compaction(self):
        path = os.path.join(self.root, "ab.jsonl")

        with redirect_stdout(io.StringIO()):
            summarise_runs.export_ab(self.rows, self.root, path)

        with open(path, encoding="utf-8") as handle:
            self.assertEqual(len(handle.readlines()), 3)


if __name__ == "__main__":
    unittest.main()
