#!/usr/bin/env bash
# Scenariotest (eisen 1-9 uit de spec) tegen een echte budget-export.
# Start per run een verse fork-container en een verse standaardcontainer op
# een eigen docker-netwerk, en draait Playwright in een container ernaast.
# Alles wordt na afloop opgeruimd, ook bij een fout of Ctrl-C.
#
# Gebruik: periods/scenario/run.sh <export-zip> <fork-image>
#   bv.    periods/scenario/run.sh ~/Downloads/export.zip \
#            ghcr.io/riewing/actual-server:v26.9.0-periods.1-rc.1
# Uitvoer: $SCENARIO_OUT, anders een nieuwe map onder $TMPDIR (buiten de repo).
# Standaardversie voor eis 9: $STOCK_IMAGE (default actual-server:26.9.0-alpine).
# Exitcode 0 alleen als alle eisen PASS zijn.
set -euo pipefail
# Git Bash zou container-paden (/scenario, /out) anders omzetten.
export MSYS_NO_PATHCONV=1

STOCK_IMAGE="${STOCK_IMAGE:-actualbudget/actual-server:26.9.0-alpine}"
PW_IMAGE=mcr.microsoft.com/playwright:v1.61.1-noble

if [ $# -ne 2 ]; then
  echo "Gebruik: $0 <export-zip> <fork-image>" >&2
  exit 2
fi
ZIP="$1"
FORK_IMAGE="$2"
if [ ! -f "$ZIP" ]; then
  echo "Export-zip niet gevonden: $ZIP" >&2
  exit 2
fi

# Windows-pad voor docker -v onder Git Bash, gewoon pad elders.
winpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }

HERE="$(winpath "$(dirname "$0")")"
REPO="$(winpath "$(dirname "$0")/../..")"
ZIP_FILE="$(winpath "$(dirname "$ZIP")")/$(basename "$ZIP")"

OUT="${SCENARIO_OUT:-${TMPDIR:-/tmp}/actual-scenario-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
OUT="$(winpath "$OUT")"
case "$OUT/" in
  "$REPO"/*)
    echo "Uitvoermap ligt in de repo; kies een map erbuiten: $OUT" >&2
    exit 2
    ;;
esac

RUN_ID="actual-scenario-$$-$RANDOM"
NET="$RUN_ID"
FORK="$RUN_ID-fork"
STOCK="$RUN_ID-stock"
PW="$RUN_ID-pw"

cleanup() {
  docker rm -f "$PW" "$FORK" "$STOCK" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Wegwerpwachtwoord voor beide testservers; gaat alleen via de omgeving
# naar de Playwright-container en wordt nergens getoond.
SCENARIO_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export SCENARIO_PASSWORD

echo "== Netwerk en containers starten ($RUN_ID)"
docker network create "$NET" >/dev/null
docker run -d --name "$FORK" --network "$NET" --network-alias fork \
  "$FORK_IMAGE" >/dev/null
docker run -d --name "$STOCK" --network "$NET" --network-alias stock \
  "$STOCK_IMAGE" >/dev/null

echo "== Playwright draaien; uitvoer in $OUT"
set +e
docker run --rm --name "$PW" --network "$NET" --ipc=host \
  -e SCENARIO_PASSWORD \
  -e FORK_URL=http://fork:5006 \
  -e STOCK_URL=http://stock:5006 \
  -e FORK_IMAGE="$FORK_IMAGE" \
  -e STOCK_IMAGE="$STOCK_IMAGE" \
  -v "$HERE:/scenario:ro" \
  -v "$REPO/packages/desktop-client/e2e/page-models:/page-models:ro" \
  -v "$ZIP_FILE:/input/export.zip:ro" \
  -v "$OUT:/out" \
  -v actual-scenario-npm-cache:/root/.npm \
  "$PW_IMAGE" \
  bash /scenario/in-container.sh
STATUS=$?
set -e

if [ -f "$OUT/results.md" ]; then
  echo
  cat "$OUT/results.md"
fi
echo
echo "Uitvoer: $OUT"
exit "$STATUS"
