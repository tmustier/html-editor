#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
npm --prefix "$ROOT" run lint --silent
python3 -m py_compile "$ROOT/serve.py"
python3 -m py_compile "$ROOT"/server/*.py
echo "  OK  lint + syntax clean"
"$ROOT/scripts/test.sh" --fast "$@"
