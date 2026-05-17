#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_JS="${TMPDIR:-/tmp}/html-collab-editor-client-check.js"
ROOT="$ROOT" TMP_JS="$TMP_JS" python3 - <<'PY'
import os
from pathlib import Path
root = Path(os.environ["ROOT"])
tmp_js = Path(os.environ["TMP_JS"])
js = "\n".join(p.read_text(encoding="utf-8") for p in sorted((root / "client").glob("*.js")))
tmp_js.write_text(js, encoding="utf-8")
PY
node --check "$TMP_JS"
python3 -m py_compile "$ROOT/serve.py"
python3 -m py_compile "$ROOT"/server/*.py
echo "  OK  syntax clean"
"$ROOT/scripts/test.sh" --fast "$@"
