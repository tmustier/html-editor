#!/usr/bin/env python3
"""html-collab-edit — collaboratively edit any HTML file in Chrome.

Serves the file at http://127.0.0.1:PORT/ with an injected editor overlay.
Edits, moves, resizes, and comments persist to the source file.

Usage:
    python3 serve.py /path/to/file.html [--port 8765] [--no-open]

Implementation lives in the server/ package:
    server/app.py       — argparse and HTTP server wiring
    server/routes.py    — HTTP handlers (one per editor capability)
    server/document.py  — pure BeautifulSoup mutations
    server/history.py   — undo / redo
    server/comments.py  — comment store + pi extension JSONL bridge
    server/assets.py    — read client/*.js and styles/*.css for injection
"""

from server.app import main

if __name__ == "__main__":
    main()
