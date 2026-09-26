#!/usr/bin/env bash
# Rebaset de periods-stapel op een nieuwe upstream-release en tagt een rc.
# Gebruik: periods/update.sh <vOUD> <vNIEUW>
#   vOUD    upstream-tag waar de huidige periods-stapel op gebaseerd is
#   vNIEUW  nieuwe upstream-release-tag
#
# set -euo pipefail: elke falende stap (cherry-pick-conflict, rode typecheck/lint/test)
# stopt het script direct, vóór branch -f/push -f/tag. Bij een cherry-pick-conflict staat de
# repo in conflictstatus; los op zoals hieronder beschreven en draai de resterende stappen
# handmatig (of start dit script opnieuw na een schone `git cherry-pick --abort` als je opnieuw
# wilt beginnen).
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Gebruik: periods/update.sh <vOUD> <vNIEUW>" >&2
  exit 1
fi

VOUD="$1"
VNIEUW="$2"
HIER="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HIER"

if [ -n "$(git status --porcelain)" ]; then
  echo "FOUT: werkboom niet schoon. Commit of stash eerst." >&2
  exit 1
fi

echo "== 1. Rebasen"
git fetch upstream "tag" "$VNIEUW" --no-tags
git switch -c "periods-$VNIEUW" "$VNIEUW"
git cherry-pick $(git rev-list --reverse "$VOUD..periods")
# Nieuwe upstream-workflows opruimen (behalve ons eigen periods-image.yml). Als er geen
# nieuwe bijkwamen faalt de git rm zonder argumenten netjes weg via `|| true`.
git rm -q $(git ls-files .github/workflows | grep -v periods-image.yml) 2>/dev/null \
  && git commit -m "chore(periods): nieuwe upstream-workflows uit de fork" \
  || true

echo "== 2. Checks (blokkeren de publicatie bij een fout)"
periods/dev.sh yarn typecheck
periods/dev.sh yarn lint
periods/dev.sh yarn workspace @actual-app/core test
periods/dev.sh yarn workspace @actual-app/web test

echo "== 3. Publiceren"
git branch -f periods HEAD
git switch periods
git branch -D "periods-$VNIEUW"
git push -f origin periods
git tag "$VNIEUW-periods.1-rc.1"
git push origin "$VNIEUW-periods.1-rc.1"

echo "Klaar. Draai nu de scenariotest tegen ghcr.io/riewing/actual-server:$VNIEUW-periods.1-rc.1"
echo "(zie PERIODS.md, 'Scenariotest vóór de definitieve tag'). Pas na een groene run:"
echo "  git tag $VNIEUW-periods.1 && git push origin $VNIEUW-periods.1"
