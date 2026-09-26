# Fork: budgetperiodes (riewing/actual)

Upstream Actual plus de pay-periods-feature uit actualbudget/actual#5730.
Ontwerp: `C:\Kubernetes\docs\superpowers\specs\2026-09-24-actual-fork-periodes-design.md`.

## Lock-in

Periodebudgetten staan onder maand-ID's `YYYY-13` t/m `YYYY-99`. Standaard
Actual toont ze niet. Transacties en kalenderbudgetten blijven bruikbaar.

## Stapel op `periods`

1. `feat: pay periods (squash van actualbudget/actual#5730)`
2. `chore(periods): dev-script voor yarn in een Linux-container`
3. `chore(periods): image-workflow en runbook`
4. `chore(periods): upstream-workflows uit de fork` — anders zou een tag ook upstream-release-workflows starten (o.a. publicatie naar ghcr).
5. Fix-commits, elk met een test.

## Maandelijkse update (elke upstream-release)

```bash
git fetch upstream tag vNIEUW --no-tags
git switch -c periods-vNIEUW vNIEUW
git cherry-pick $(git rev-list --reverse vOUD..periods)
# Bij een modify/delete-conflict op .github/workflows/*: het bestand verwijderen en doorgaan.
# git rm .github/workflows/<bestand> && git cherry-pick --continue
# Nieuwe upstream-workflows opruimen:
git rm -q $(git ls-files .github/workflows | grep -v periods-image.yml) 2>/dev/null && git commit -m "chore(periods): nieuwe upstream-workflows uit de fork" || true
periods/dev.sh yarn typecheck
periods/dev.sh yarn lint
periods/dev.sh yarn workspace @actual-app/core test
periods/dev.sh yarn workspace @actual-app/web test
git branch -f periods HEAD && git switch periods && git branch -D periods-vNIEUW
git push -f origin periods
git tag vNIEUW-periods.1-rc.1 && git push origin vNIEUW-periods.1-rc.1
```

Daarna de scenariotest (eisen 1–9 uit de spec, plus eis 10: verse client) tegen de rc-image. Pas als die
groen is: tag `vNIEUW-periods.1` en de image-regel in
`k3s-homelab/services/budget/budget.yml` bijwerken.

### Scenariotest vóór de definitieve tag

Draai vóór het taggen van `vNIEUW-periods.1` de scenariotest tegen de rc-image,
met een verse export uit productie (_Settings → Export data_):

```bash
periods/scenario/run.sh <export-zip> ghcr.io/riewing/actual-server:<rc-tag>
```

Het script start een verse fork-container en een verse standaardcontainer
(`actual-server:26.9.0-alpine`) op een eigen docker-netwerk, draait Playwright
in `mcr.microsoft.com/playwright:v1.61.1-noble` en ruimt alles na afloop op.
De zip wordt alleen-lezen gemount. De uitvoer (`results.md`, `results.json`,
schermafdrukken bij een fout) komt in `$SCENARIO_OUT`, anders in een nieuwe
map onder `$TMPDIR`, altijd buiten de repo. Commit geen export, uitvoer of
schermafdrukken. De exitcode is 0 als alle eisen PASS zijn. FAIL is een
productfout. UNVERIFIED betekent dat het script de eis niet kon toetsen.

Zet bij een nieuwe upstream-versie `STOCK_IMAGE` op de bijbehorende standaardimage
(bv. `STOCK_IMAGE=actualbudget/actual-server:<NIEUW>-alpine`); de default is
`26.9.0-alpine`. Houd de Playwright-image gelijk aan de versie van `@playwright/test` in
`packages/desktop-client/package.json`.
