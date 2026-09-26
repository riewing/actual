#!/usr/bin/env bash
# Draait een commando in een Linux-container met de fork op /src.
# node_modules staat in een named volume: sneller dan een Windows-bind-mount,
# en blijft tussen runs bewaard.
# Gebruik: periods/dev.sh yarn typecheck
set -euo pipefail
# Git Bash zou /src anders omzetten naar C:/Program Files/Git/src.
export MSYS_NO_PATHCONV=1
REPO="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0: met -t wacht corepack anders op een Y/n-prompt.
exec docker run --rm -t \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -v "$REPO:/src" \
  -v actual-periods-node-modules:/src/node_modules \
  -w /src \
  node:24.18.1-bookworm \
  bash -lc 'corepack enable >/dev/null && yarn install --immutable >/dev/null && "$@"' _ "$@"
