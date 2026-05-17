"""Comment store + pi extension bridge.

Comments live in <html-file>.comments.json (a JSON array). On each new comment
we optionally append a JSONL line to a bridge file that the pi extension
watches; the line includes the source file path so the extension can route
multi-session edits correctly.

The bridge file is configurable per-server (see CommentStore.bridge_path).
Pass bridge_path=None to disable the bridge entirely. This is the default so
local tests and ad-hoc servers cannot accidentally broadcast into every live
pi session.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

# Historical shared file. Kept as a named constant for explicit legacy use,
# but no caller should use it by default because every active pi session could
# see it.
LEGACY_SHARED_BRIDGE_FILE = Path("/tmp/html-editor-comments.jsonl")
DEFAULT_BRIDGE_FILE: Optional[Path] = None

# Back-compat alias for any callers that still import BRIDGE_FILE directly.
BRIDGE_FILE = LEGACY_SHARED_BRIDGE_FILE


class CommentStore:
    def __init__(
        self,
        comments_path: Path,
        bridge_path: Optional[Path] = DEFAULT_BRIDGE_FILE,
    ):
        self.path = comments_path
        # bridge_path=None disables the pi-extension bridge entirely. Useful
        # for e2e tests so they don't pollute live pi sessions.
        self.bridge_path = bridge_path

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
        if self.bridge_path is not None:
            _append_bridge(self.bridge_path, entry)
        return entry


def _append_bridge(bridge_path: Path, entry: dict) -> None:
    """Append a single JSONL line for the pi extension watcher."""
    bridge_path.parent.mkdir(parents=True, exist_ok=True)
    with bridge_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
