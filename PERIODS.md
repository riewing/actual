# Fork: budgetperiodes (riewing/actual)

Upstream Actual plus de pay-periods-feature uit actualbudget/actual#5730.
Ontwerp: `C:\Kubernetes\docs\superpowers\specs\2026-09-24-actual-fork-periodes-design.md`.

## Lock-in

Periodebudgetten staan onder maand-ID's `YYYY-13` t/m `YYYY-99`. Standaard
Actual toont ze niet. Transacties en kalenderbudgetten blijven bruikbaar.

## Stapel op `periods`

Categorieën, geen vaste volgorde (de stapel groeit met elke maandelijkse update):

- de squash-commit van `actualbudget/actual#5730`;
- infrastructuur van de fork: `periods/dev.sh`, de image-workflow, de release-signaal-workflow;
- opruimcommit(s) voor upstream-workflows die een cherry-pick meebrengt;
- fix-commits, elk met een test die eerst rood was;
- documentatiecommits (dit bestand, de scenariotest).

## Signaal bij een nieuwe upstream-release

`.github/workflows/upstream-release-check.yml` draait wekelijks (en handmatig via
`workflow_dispatch`) en opent een issue "Upstream-release vX beschikbaar — periods-stapel
rebasen" zodra `actualbudget/actual` een nieuwere release heeft dan de basis van deze
stapel. Bron van waarheid voor die basis: de nieuwste `v*-periods.*`-tag (zonder `-rc`) op
deze repo — dezelfde tag die `periods/update.sh` en `tools/actual-probe/setup.sh` lezen.
Geen aparte versieregel om uit sync te laten lopen. Renovate op `k3s-homelab` meldt dit
niet meer (`ghcr.io/riewing/**` staat daar bewust op `enabled: false`); dit issue is de
vervanging.

## Maandelijkse update (elke upstream-release)

Gebruik `periods/update.sh <vOUD> <vNIEUW>`. Het script draait onder `set -euo pipefail`:
elke falende stap (cherry-pick-conflict, rode typecheck/lint/test) stopt het script vóór
`branch -f`, `push -f` en de tag. Er verandert dan niets aan `periods` of op de remote.

```bash
periods/update.sh v26.9.0 v26.10.0
```

Bij een modify/delete-conflict op `.github/workflows/*` tijdens de cherry-pick: het
script stopt met de repo in conflictstatus. Los op met
`git rm .github/workflows/<bestand> && git cherry-pick --continue`, rond de resterende
cherry-picks af, en draai dan handmatig het restant van het script (opruimcommit, de vier
checks, en pas na een groene run `branch -f`/`push -f`/de rc-tag — zie de stappen in
`periods/update.sh` zelf). Begin je liever helemaal opnieuw: `git cherry-pick --abort`,
verwijder de tussenbranch en start het script opnieuw.

Na een groene rc: de scenariotest (hieronder). Pas daarna de definitieve tag zetten:

```bash
git tag vNIEUW-periods.1 && git push origin vNIEUW-periods.1
```

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

Wat mee moet bij een nieuwe upstream-versie:

- `STOCK_IMAGE` op de bijbehorende standaardimage zetten (bv.
  `STOCK_IMAGE=actualbudget/actual-server:<NIEUW>-alpine`); de default is `26.9.0-alpine`;
- de Playwright-image gelijk houden aan de versie van `@playwright/test` in
  `packages/desktop-client/package.json`;
- in `C:\Kubernetes\tools\actual-probe\test\e2e-download.test.js` pint `IMAGE` ook op
  `actualbudget/actual-server:26.9.0-alpine` — die regel hoort in dezelfde ronde mee te
  gaan, ook al staat dat bestand buiten deze repo.

### Uitrol na de definitieve tag

Dit is een aparte, latere stap dan het taggen hierboven en raakt productie. Voor de
interne paden (backup-runbook, GitOps-repo, secretnamen) geldt `docs/huidige-architectuur.md`
en `docs/sealed-secrets-herstel.md` in `C:\Kubernetes` — die zijn bewust niet hier publiek
herhaald. Kort en generiek:

1. Backupcheck: laatste `budget-db-dump`-run en de Longhorn-backup van het volume zijn
   geslaagd.
2. Image-regel bijwerken in `k3s-homelab/services/budget/budget.yml` naar
   `ghcr.io/riewing/actual-server:vNIEUW-periods.1`.
3. `gitops-manifest-reviewer` en `deploy-check` vóór de push.
4. De push naar `main` is een productieactie: alleen na expliciet "ja" van de gebruiker in
   die sessie.
5. ArgoCD volgen tot Synced/Healthy.
6. Het budget in de browser sluiten en heropenen. Een service worker/SharedWorker houdt
   anders de oude client vast, ook na een refresh.
7. `tools/actual-probe/setup.sh` in `C:\Kubernetes` opnieuw draaien (bouwt de API-client
   opnieuw uit deze tag).
8. Nameten: `node probe.js maand <huidige periode>` en `node probe.js invariant`.

### Bekende beperkingen

- **Vlagvolgorde.** De backend negeert de experimentele periode-vlag zelf; alleen
  `showPayPeriods` aan de clientkant schakelt om. Zet je periodes uit terwijl
  `showPayPeriods` nog aan staat, dan blijft `createAllBudgets` periodegrenzen
  teruggeven terwijl de frontend met kalendermaanden rekent — dat geeft zo goed als
  zeker hetzelfde "alles op nul"-beeld als de productiestoring die deze fork oploste.
  **Regel: eerst periodes uitzetten, dán de vlag uit.**
- **Gemiddelden.** `getFirstActivityMonth` mengt kalendermaand-ID's en periode-ID's.
  Gemiddelde-templates en "budget average" kunnen daardoor te laag uitkomen zodra de
  periodeweergave langer meeloopt. Nog niet urgent; wordt het zodra gemiddelden gebruikt
  gaan worden.
- **Mobiel valt buiten scope.** De PR maakte de mobiele UI niet af; niet getest, niet
  gefixt.
- **Scenariotest met hardcoded categorienamen.** `periods/scenario/*.spec.ts` verwacht de
  categorienamen _Boodschappen_, _Verzorging_ en _Sport_. Verdwijnen of hernoemen die
  categorieën (bv. bij het opruimen van _Usual Expenses_), dan geeft de eerstvolgende
  maandelijkse run UNVERIFIED in plaats van PASS voor die eis — geen productfout, wel een
  test die moet worden bijgewerkt.
- **`master` van de fork niet syncen.** `master` bevat nog alle upstream-workflows
  (`build`, `check`, `electron-master`, …). GitHub's "Sync fork" op `master` is een push
  en start die workflows in deze fork. De procedure hierboven heeft `master` niet nodig;
  hij werkt met upstream-tags via `git fetch upstream tag`.
- **De e2e-probe-test pint de standaardimage.** Zie "Wat mee moet" hierboven.
