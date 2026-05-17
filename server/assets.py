"""Read+concatenate the editor JS and CSS chunks from disk at import time.

These chunks are injected into the served page; the order is filename order
(00-bootstrap.js, 10-ui.js, ...). No build step.
"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
CLIENT_JS_DIR = HERE / "client"
STYLE_DIR = HERE / "styles"


def _read_ordered_text(directory: Path, pattern: str, kind: str) -> str:
    files = sorted(directory.glob(pattern)) if directory.exists() else []
    if not files:
        raise RuntimeError(f"no {kind} files found in {directory}")
    chunks = []
    for path in files:
        chunks.append(
            f"\n/* ---- {path.relative_to(HERE)} ---- */\n"
            + path.read_text(encoding="utf-8")
        )
    return "\n".join(chunks)


EDITOR_JS = _read_ordered_text(CLIENT_JS_DIR, "*.js", "client JavaScript")
EDITOR_CSS = _read_ordered_text(STYLE_DIR, "*.css", "editor CSS")
