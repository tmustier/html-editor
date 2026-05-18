#!/usr/bin/env bash
set -euo pipefail

RUFF_VERSION="0.15.13"

ruff_matches_pin() {
  local cmd_version
  cmd_version="$($@ --version 2>/dev/null | awk '{print $2}')"
  [[ "$cmd_version" == "$RUFF_VERSION" ]]
}

if command -v ruff >/dev/null 2>&1 && ruff_matches_pin ruff; then
  exec ruff "$@"
fi

if python3 -m ruff --version >/dev/null 2>&1 && ruff_matches_pin python3 -m ruff; then
  exec python3 -m ruff "$@"
fi

if command -v uv >/dev/null 2>&1; then
  exec uvx --from "ruff==$RUFF_VERSION" ruff "$@"
fi

echo "ruff $RUFF_VERSION is required for Python linting." >&2
echo "Install it with: python3 -m pip install -r requirements-dev.txt, or install uv." >&2
exit 127
