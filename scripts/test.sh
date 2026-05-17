#!/usr/bin/env bash
# Run all server unit tests. Fast (sub-second) and deterministic.
# Future: scripts/e2e.sh will add Playwright browser tests on top.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
python3 -m unittest discover tests "$@"
