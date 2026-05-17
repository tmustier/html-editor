"""Tests for server/history.py — undo/redo against a real on-disk file."""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from server import history as H


class HistoryRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.path = Path(self.tmp.name) / "doc.html"
        self.path.write_text("v0", encoding="utf-8")
        self.h = H.History(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_undo_with_no_history_returns_false(self):
        self.assertFalse(self.h.undo())

    def test_redo_with_no_history_returns_false(self):
        self.assertFalse(self.h.redo())

    def test_remember_then_undo_restores_previous(self):
        self.h.remember()                 # stack now has "v0"
        self.path.write_text("v1", encoding="utf-8")
        self.assertTrue(self.h.undo())
        self.assertEqual(self.path.read_text(), "v0")

    def test_undo_then_redo_round_trips(self):
        self.h.remember()
        self.path.write_text("v1", encoding="utf-8")
        self.h.undo()
        self.assertTrue(self.h.redo())
        self.assertEqual(self.path.read_text(), "v1")

    def test_new_remember_clears_redo_stack(self):
        self.h.remember()
        self.path.write_text("v1", encoding="utf-8")
        self.h.undo()              # back to v0; redo stack has v1
        self.h.remember()          # branch off v0 — should clear redo
        self.path.write_text("v2", encoding="utf-8")
        self.assertFalse(self.h.redo())

    def test_max_history_cap(self):
        # We write 1 + MAX_HISTORY + 5 versions; the oldest must drop off.
        for i in range(H.MAX_HISTORY + 5):
            self.h.remember()
            self.path.write_text(f"v{i+1}", encoding="utf-8")
        # We can undo MAX_HISTORY times and then run out.
        for _ in range(H.MAX_HISTORY):
            self.assertTrue(self.h.undo())
        self.assertFalse(self.h.undo())


if __name__ == "__main__":
    unittest.main()
