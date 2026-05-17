"""Comment store + pi extension bridge.

Comments live in <html-file>.comments.json (a JSON array). On each new comment
we also append a JSONL line to a shared bridge file that the pi extension
watches; the line includes the source file path so the extension can route
multi-session edits correctly.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

# Shared across all editor sessions. Each line contains "file" so the pi
# extension can disambiguate.
BRIDGE_FILE = Path("/tmp/html-editor-comments.jsonl")


class CommentStore:
    def __init__(self, comments_path: Path):
        self.path = comments_path

    def load(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return []
        return data if isinstance(data, list) else []

    def _save(self, data: list[dict]) -> None:
        self.path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def add(self, edit_id: str, tag: str, comment: str, excerpt: str,
            source_file: Path) -> dict:
        entry = {
            "id": edit_id,
            "tag": tag,
            "comment": comment,
            "excerpt": excerpt,
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "file": str(source_file),
        }
        data = self.load()
        data.append(entry)
        self._save(data)
        _append_bridge(entry)
        return entry


def _append_bridge(entry: dict) -> None:
    """Append a single JSONL line for the pi extension watcher."""
    BRIDGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with BRIDGE_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
