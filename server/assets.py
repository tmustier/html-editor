"""Editor asset access.

- Client JS lives in client/*.js as native ES modules. The server serves
  them as static files under /__editor/client/<name>.js. Each module reads
  its own imports; only client/main.js is referenced from the host page.
- CSS still concatenates styles/*.css into one stylesheet served at
  /__editor/main.css. Filename order is the precedence order.

Files are read on demand (not cached at import time) so editing them and
reloading the page picks up the change.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent.parent
CLIENT_JS_DIR = HERE / "client"
STYLE_DIR = HERE / "styles"

CLIENT_ENTRY = "main.js"  # the module the host page loads


def read_client_module(name: str) -> Optional[bytes]:
    """Return the bytes of client/<name> if it's a .js file in CLIENT_JS_DIR.
    Returns None for anything else (so the route can 404 cleanly).
    """
    if not name.endswith(".js"):
        return None
    path = CLIENT_JS_DIR / name
    try:
        # Resolve and confirm the resolved path is still inside CLIENT_JS_DIR
        # so we never serve ../../../../etc/passwd.
        resolved = path.resolve()
        resolved.relative_to(CLIENT_JS_DIR.resolve())
    except (OSError, ValueError):
        return None
    if not resolved.is_file():
        return None
    return resolved.read_bytes()


def read_bundled_css() -> bytes:
    """Concatenate styles/*.css in filename order."""
    files = sorted(STYLE_DIR.glob("*.css")) if STYLE_DIR.exists() else []
    if not files:
        raise RuntimeError(f"no editor CSS files found in {STYLE_DIR}")
    chunks = []
    for path in files:
        chunks.append(
            f"\n/* ---- {path.relative_to(HERE)} ---- */\n"
            + path.read_text(encoding="utf-8")
        )
    return "\n".join(chunks).encode("utf-8")
