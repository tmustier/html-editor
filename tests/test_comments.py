"""Tests for server/comments.py — file-backed store + JSONL bridge.

We monkey-patch BRIDGE_FILE to a tempfile so we don't trample the real one
when running tests in parallel with a live editor session.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from server import comments as C


class CommentStoreFlow(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.cpath = Path(self.tmp.name) / "doc.html.comments.json"
        self.bridge = Path(self.tmp.name) / "bridge.jsonl"
        self._original_bridge = C.BRIDGE_FILE
        C.BRIDGE_FILE = self.bridge

    def tearDown(self):
        C.BRIDGE_FILE = self._original_bridge
        self.tmp.cleanup()

    def test_load_returns_empty_when_no_file(self):
        store = C.CommentStore(self.cpath)
        self.assertEqual(store.load(), [])

    def test_load_returns_empty_on_corrupt_json(self):
        self.cpath.write_text("{not valid", encoding="utf-8")
        store = C.CommentStore(self.cpath)
        self.assertEqual(store.load(), [])

    def test_load_returns_empty_when_root_is_not_a_list(self):
        self.cpath.write_text('{"oops": true}', encoding="utf-8")
        store = C.CommentStore(self.cpath)
        self.assertEqual(store.load(), [])

    def test_add_appends_to_file_and_bridge(self):
        store = C.CommentStore(self.cpath)
        entry = store.add("e1", "p", "tighten this", "the excerpt", Path("/some/doc.html"))
        self.assertEqual(entry["id"], "e1")
        self.assertEqual(entry["comment"], "tighten this")
        self.assertEqual(entry["file"], "/some/doc.html")
        self.assertIn("timestamp", entry)

        on_disk = json.loads(self.cpath.read_text())
        self.assertEqual(len(on_disk), 1)
        self.assertEqual(on_disk[0]["comment"], "tighten this")

        bridge_lines = self.bridge.read_text().splitlines()
        self.assertEqual(len(bridge_lines), 1)
        self.assertEqual(json.loads(bridge_lines[0])["comment"], "tighten this")

    def test_multiple_adds_accumulate(self):
        store = C.CommentStore(self.cpath)
        store.add("e1", "p", "first", "", Path("/x"))
        store.add("e2", "div", "second", "", Path("/x"))
        on_disk = json.loads(self.cpath.read_text())
        self.assertEqual([c["comment"] for c in on_disk], ["first", "second"])
        bridge_lines = self.bridge.read_text().splitlines()
        self.assertEqual(len(bridge_lines), 2)


if __name__ == "__main__":
    unittest.main()
