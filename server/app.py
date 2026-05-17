"""Server entry-point: argparse, ThreadingHTTPServer wiring, banner."""

from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path

from . import document
from .comments import BRIDGE_FILE
from .routes import make_handler


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Serve an HTML file with an inline collaborative editor "
                    "overlay; writes edits back to the source file.")
    ap.add_argument("file", help="Path to the HTML file to edit")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true",
                    help="Don't auto-open the browser")
    args = ap.parse_args()

    html_path = Path(args.file).resolve()
    if not html_path.exists():
        sys.stderr.write(f"file not found: {html_path}\n")
        sys.exit(1)

    comments_path = html_path.with_suffix(html_path.suffix + ".comments.json")

    document.ensure_edit_ids(html_path)

    Handler = make_handler(html_path, comments_path)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    sys.stderr.write(
        f"\n  serving:   {html_path}\n"
        f"  url:       {url}\n"
        f"  comments:  {comments_path}\n"
        f"  bridge:    {BRIDGE_FILE}  (load pi extension html-editor-comments + /reload)\n"
        f"  (Ctrl-C to stop)\n\n"
    )
    sys.stderr.flush()

    if not args.no_open:
        threading.Thread(
            target=lambda: (time.sleep(0.35), webbrowser.open(url)),
            daemon=True,
        ).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nbye\n")
