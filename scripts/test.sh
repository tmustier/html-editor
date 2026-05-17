#!/usr/bin/env bash
# Run unit tests and, by default, Playwright e2e tests.
#
#   ./scripts/test.sh          # unit + headless e2e
#   ./scripts/test.sh --fast   # unit only
#   ./scripts/test.sh --ui     # unit + Playwright UI mode
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mode="all"
if [[ "${1:-}" == "--fast" ]]; then
  mode="fast"
  shift
elif [[ "${1:-}" == "--ui" ]]; then
  mode="ui"
  shift
fi

python3 -m unittest discover -s tests -p 'test_*.py'

if [[ "$mode" == "fast" ]]; then
  exit 0
fi

if [[ "$mode" == "ui" ]]; then
  exec npx playwright test --ui "$@"
fi

npx playwright test "$@"
