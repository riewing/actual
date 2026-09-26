#!/usr/bin/env bash
# Draait in de Playwright-container (zie run.sh). Installeert alleen
# @playwright/test in een wegwerpmap en hergebruikt de page-models uit
# packages/desktop-client/e2e.
set -euo pipefail
mkdir -p /work
cd /work
cp /scenario/playwright.config.ts /scenario/scenario.spec.ts /work/
cp -r /page-models /work/page-models
cat > package.json <<'JSON'
{ "name": "actual-periods-scenario", "private": true }
JSON
npm install --silent --no-audit --no-fund @playwright/test@1.61.1 >/dev/null
exec npx playwright test --config /work/playwright.config.ts
