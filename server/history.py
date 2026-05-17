"""Thread-safe undo/redo history backed by the on-disk HTML file.

We snapshot the whole file rather than the diff because the operations we
support (text replace, move, resize, transform) span enough of the document
that a full-file snapshot is both simpler and easier to reason about. With a
50-snapshot cap and typical files in the 100–200 KB range, this costs at most
a few MB of process memory.
"""

from __future__ import annotations

import threading
from pathlib import Path

MAX_HISTORY = 50


class History:
    def __init__(self, path: Path):
        self.path = path
        self._undo: list[str] = []
        self._redo: list[str] = []
        self._lock = threading.Lock()

    def remember(self) -> None:
        """Push current file contents onto the undo stack. Call before each
        mutation. Clears the redo stack (linear history)."""
        with self._lock:
            self._undo.append(self.path.read_text(encoding="utf-8"))
            if len(self._undo) > MAX_HISTORY:
                self._undo.pop(0)
            self._redo.clear()

    def undo(self) -> bool:
        with self._lock:
            if not self._undo:
                return False
            current = self.path.read_text(encoding="utf-8")
            previous = self._undo.pop()
            self._redo.append(current)
            self.path.write_text(previous, encoding="utf-8")
        return True

    def redo(self) -> bool:
        with self._lock:
            if not self._redo:
                return False
            current = self.path.read_text(encoding="utf-8")
            next_state = self._redo.pop()
            self._undo.append(current)
            if len(self._undo) > MAX_HISTORY:
                self._undo.pop(0)
            self.path.write_text(next_state, encoding="utf-8")
        return True
