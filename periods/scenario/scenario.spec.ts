// Scenariotest budgetperiodes (eisen 1-9 uit de spec, plus eis 10), zie run.sh.
// Draait tegen wegwerpcontainers met een echte export. Privacy: de uitvoer
// bevat alleen oordelen per eis, labels en totalen; geen begunstigden,
// notities of losse transacties.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// @playwright/test wordt in de Playwright-container geinstalleerd (in-container.sh),
// niet via een workspace-package.json.
// oxlint-disable actual/no-extraneous-dependencies
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

import { BudgetPage } from './page-models/budget-page';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

const FORK_URL = process.env.FORK_URL ?? 'http://fork:5006';
const STOCK_URL = process.env.STOCK_URL ?? 'http://stock:5006';
const PASSWORD = process.env.SCENARIO_PASSWORD ?? '';
const EXPORT_ZIP = '/input/export.zip';
const OUT = '/out';

// Periodes: monthly, start 2026-09-20. Met die instelling is periode-ID
// YYYY-(12+n) de n-de periode die in jaar YYYY begint (20e t/m 19e).
const START_DATE = '2026-09-20';
// Echte datum; de periodes blijven vast, zodat de test ook met een latere
// export (die al periodebudgetten bevat) te herhalen is.
const TODAY = new Date().toLocaleDateString('sv-SE', {
  timeZone: 'Europe/Amsterdam',
});

/** Periode-ID (monthly, vanaf de 20e) waarin een datum yyyy-MM-dd valt. */
function periodIdFor(date: string) {
  let [y, m] = date.split('-').map(Number);
  if (Number(date.slice(8, 10)) < 20) {
    m--;
  }
  if (m < 1) {
    m = 12;
    y--;
  }
  return `${y}-${m + 12}`;
}
const P0 = { id: '2026-20', start: '2026-08-20', end: '2026-09-19' };
const P1 = { id: '2026-21', start: '2026-09-20', end: '2026-10-19' };
const P2 = { id: '2026-22', start: '2026-10-20', end: '2026-11-19' };

const CAT_GROCERIES = 'Boodschappen';
const CAT_CARE = 'Verzorging';
const CAT_SPORT = 'Sport';

const PERIOD_ID = /^\d{4}-(1[3-9]|[2-9]\d)$/;
const CALENDAR_ID = /^\d{4}-(0[1-9]|1[0-2])$/;

type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED';
type Observed = Record<string, string | number | boolean | null>;
type Result = {
  req: number;
  title: string;
  verdict: Verdict;
  observed: Observed;
  note: string;
};

const results: Result[] = [];

/** Het product voldoet niet aan de eis (in tegenstelling tot een scriptfout). */
class ProductFail extends Error {}

function requireThat(cond: boolean, message: string): asserts cond {
  if (!cond) {
    throw new ProductFail(message);
  }
}

function euro(cents: number | null | undefined) {
  return cents == null ? null : (cents / 100).toFixed(2);
}

function log(line: string) {
  // oxlint-disable-next-line actual/prefer-logger-over-console -- testuitvoer
  console.log(line);
}

async function check(
  page: Page | null,
  req: number,
  title: string,
  fn: (obs: Observed) => Promise<void>,
) {
  const obs: Observed = {};
  let verdict: Verdict = 'PASS';
  let note = '';
  try {
    await fn(obs);
  } catch (e) {
    const err = e as Error;
    verdict = err instanceof ProductFail ? 'FAIL' : 'UNVERIFIED';
    // Alleen de eerste regel: Playwright-calllogs kunnen paginatekst bevatten.
    note = String(err.message ?? err)
      // oxlint-disable-next-line no-control-regex -- ANSI-kleurcodes
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')[0]
      .slice(0, 300);
    if (page) {
      mkdirSync(`${OUT}/failures`, { recursive: true });
      await page
        .screenshot({ path: `${OUT}/failures/eis-${req}.png`, fullPage: true })
        .catch(() => undefined);
    }
  }
  results.push({ req, title, verdict, observed: obs, note });
  log(`[eis ${req}] ${verdict} ${title}${note ? ` -- ${note}` : ''}`);
}

// ---------- toegang tot de app ----------

type SendFn = (name: string, args?: unknown) => Promise<unknown>;

async function send<T>(page: Page, name: string, args?: unknown): Promise<T> {
  return (await page.evaluate(
    ([n, a]) => (window as unknown as { $send: SendFn }).$send(n, a),
    [name, args] as [string, unknown],
  )) as T;
}

/** Som (centen) en aantal van transacties via AQL; alleen aggregaten. */
async function txAggregate(page: Page, filter: Record<string, unknown>) {
  return page.evaluate(async f => {
    type Q = {
      filter: (x: unknown) => Q;
      calculate: (x: unknown) => Q;
    };
    const w = window as unknown as {
      $query: (q: Q) => Promise<{ data: unknown }>;
      $q: (table: string) => Q;
    };
    const sum = await w.$query(
      w.$q('transactions').filter(f).calculate({ $sum: '$amount' }),
    );
    const count = await w.$query(
      w.$q('transactions').filter(f).calculate({ $count: '$id' }),
    );
    return { sum: Number(sum.data ?? 0), count: Number(count.data ?? 0) };
  }, filter);
}

/** Alleen datum en split-vlag van transacties; geen bedragen of namen. */
async function txDates(page: Page, filter: Record<string, unknown>) {
  const rows = await page.evaluate(async f => {
    type Q = {
      filter: (x: unknown) => Q;
      select: (x: unknown) => Q;
    };
    const w = window as unknown as {
      $query: (q: Q) => Promise<{ data: unknown }>;
      $q: (table: string) => Q;
    };
    const res = await w.$query(
      w.$q('transactions').filter(f).select(['date', 'is_child']),
    );
    return res.data as Array<{ date: string; is_child: boolean }>;
  }, filter);
  return {
    count: rows.length,
    dates: rows.map(r => r.date).sort(),
    children: rows.filter(r => r.is_child).length,
  };
}

type Cells = Record<string, number>;

/** Alle waarden van het envelopbudget-sheet van een maand of periode. */
async function sheet(page: Page, month: string): Promise<Cells> {
  const rows = await send<Array<{ name: string; value: unknown }>>(
    page,
    'envelope-budget-month',
    { month },
  );
  const cells: Cells = {};
  for (const r of rows) {
    cells[r.name.split('!')[1]] = Number(r.value ?? 0);
  }
  return cells;
}

async function waitForCell(
  page: Page,
  month: string,
  cell: string,
  expected: number,
) {
  await expect
    .poll(async () => (await sheet(page, month))[cell], {
      timeout: 20_000,
      message: `${cell} in ${month} werd niet ${euro(expected)}`,
    })
    .toBe(expected);
}

/**
 * AQL-filter voor de datums van een periode. Twee operatoren in één
 * `date`-object werken niet (alleen de eerste telt), vandaar $and.
 */
function inPeriod(p: { start: string; end: string }) {
  return { $and: [{ date: { $gte: p.start } }, { date: { $lte: p.end } }] };
}

type Category = { id: string; name: string; is_income: boolean };

async function categories(page: Page) {
  const res = await send<{ list: Category[] }>(page, 'get-categories');
  return res.list;
}

async function categoryId(page: Page, name: string) {
  const cat = (await categories(page)).find(c => c.name === name);
  if (!cat) {
    throw new Error(`categorie ${name} niet gevonden in de export`);
  }
  return cat.id;
}

/** Parseert een bedrag zoals de UI het toont (1.234,56 of 1,234.56). */
function parseAmount(text: string): number {
  const t = text
    .replaceAll(String.fromCharCode(0x2212), '-')
    .replace(/[^\d,.-]/g, '');
  const m = t.match(/^(-?)([\d.,]*?)[.,](\d{2})$/);
  if (m) {
    const whole = parseInt(m[2].replace(/[.,]/g, '') || '0', 10);
    return (m[1] ? -1 : 1) * (whole * 100 + parseInt(m[3], 10));
  }
  const whole = parseInt(t.replace(/[.,]/g, ''), 10);
  if (Number.isNaN(whole)) {
    throw new Error(`bedrag niet te lezen: "${text.slice(0, 20)}"`);
  }
  return whole * 100;
}

/** Decimaalteken van het budget (synced pref numberFormat), na de import gezet. */
let decimalSep = '.';

async function readNumberFormat(page: Page) {
  const prefs = await send<Record<string, string>>(page, 'preferences/get');
  const fmt = prefs.numberFormat ?? 'comma-dot';
  decimalSep = /-comma$/.test(fmt) ? ',' : '.';
}

/** Bedrag in centen als invoertekst in het formaat van het budget. */
function amountInput(cents: number) {
  return (cents / 100).toFixed(2).replace('.', decimalSep);
}

// ---------- UI-stappen ----------

async function signInAndImport(browser: Browser, url: string, zip: string) {
  const res = await fetch(`${url}/account/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`bootstrap van ${url} faalde: HTTP ${res.status}`);
  }
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message.slice(0, 200)));
  await page.goto(url);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await new ConfigurationPage(page).importBudget('Actual', zip);
  const budgetPage = new BudgetPage(page);
  await budgetPage.waitFor({ timeout: 120_000 });
  await dismissTour(page);
  return { page, budgetPage, pageErrors };
}

/**
 * Een tweede, verse client (lege opslag): inloggen en het budget openen via
 * de serverlijst, zodat het gedownload wordt inclusief gesyncte prefs.
 */
async function openFromServer(browser: Browser, url: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message.slice(0, 200)));
  await page.goto(url);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const files = page.getByRole('grid', { name: 'Budget files' });
  await expect(files.getByRole('row')).toHaveCount(1, { timeout: 30_000 });
  await files.getByRole('row').first().click();
  await new BudgetPage(page).waitFor({ timeout: 120_000 });
  await dismissTour(page);
  return { context, page, pageErrors };
}

async function uiIncome(page: Page) {
  // Eerste 'received'-cel in de tabel = totaalrij van de inkomsten.
  return parseAmount(
    await page
      .getByTestId('budget-table')
      .getByTestId('received')
      .first()
      .innerText(),
  );
}

async function dismissTour(page: Page) {
  const tour = page.getByText('Welcome to Actual!');
  await tour.waitFor({ timeout: 5000 }).catch(() => undefined);
  if (await tour.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /close/i }).last().click();
  }
}

function summary(page: Page, month: string) {
  return page.locator(`[data-testid="budget-summary"][data-month="${month}"]`);
}

async function selectedMonth(page: Page) {
  return (
    (await page
      .getByTestId('selected-budget-month')
      .getAttribute('data-month')) ?? ''
  );
}

/** Bladert met vorige/volgende tot `month` geselecteerd is. */
async function gotoMonth(page: Page, month: string) {
  for (let i = 0; i < 40; i++) {
    const cur = await selectedMonth(page);
    if (cur === month) {
      await summary(page, month).waitFor();
      return;
    }
    await page
      .getByTitle(cur < month ? 'Next month' : 'Previous month')
      .click();
    await expect(page.getByTestId('selected-budget-month')).not.toHaveAttribute(
      'data-month',
      cur,
    );
  }
  throw new Error(`maand/periode ${month} niet bereikbaar`);
}

/** De checkbox is gebonden aan een synced pref en wisselt pas na een round-trip. */
async function setPeriodView(page: Page, on: boolean) {
  const box = page.getByLabel('Show pay periods');
  if ((await box.isChecked()) !== on) {
    await box.click();
  }
  await expect(box).toBeChecked({ checked: on });
}

function categoryRow(page: Page, name: string) {
  return page
    .getByTestId('budget-table')
    .getByTestId('row')
    .filter({
      has: page.getByTestId('category-name').getByText(name, { exact: true }),
    })
    .first();
}

/**
 * Het bedrag onder "To Budget:" / "Overbudgeted:" in de samenvatting.
 * Het element heeft geen bruikbaar testid, dus lezen we de tekstregels.
 */
async function uiToBudgetText(page: Page, month: string) {
  const lines = (await summary(page, month).innerText())
    .split('\n')
    .map(l => l.trim());
  const idx = lines.findIndex(l => /^(To Budget|Overbudgeted):$/.test(l));
  if (idx < 0 || !lines[idx + 1]) {
    throw new Error('To Budget niet gevonden in de samenvatting');
  }
  return lines[idx + 1];
}

async function uiToBudget(page: Page, month: string) {
  return parseAmount(await uiToBudgetText(page, month));
}

async function clickToBudget(page: Page, month: string) {
  // De samenvatting staat in een carrousel en is deels afgesneden; een
  // gewone click faalt op de zichtbaarheidscheck. Zie clickReactAriaButton
  // in e2e/page-models/navigation.ts voor hetzelfde patroon.
  await summary(page, month)
    .getByText(/^(To Budget|Overbudgeted):$/)
    .locator('xpath=following-sibling::*[1]')
    .locator('[data-cellname]')
    .evaluate((el: HTMLElement) => el.click());
}

async function uiTotal(page: Page, testId: RegExp) {
  return parseAmount(
    await page.getByTestId('budget-totals').getByTestId(testId).innerText(),
  );
}

async function calendarBudgets(page: Page, months: string[]) {
  const cats = (await categories(page)).filter(c => !c.is_income);
  const snap: Record<string, number> = {};
  for (const m of months) {
    const cells = await sheet(page, m);
    for (const c of cats) {
      snap[`${m}/${c.id}`] = cells[`budget-${c.id}`] ?? 0;
    }
    snap[`${m}/total-budgeted`] = cells['total-budgeted'] ?? 0;
  }
  return snap;
}

function monthRange(start: string, end: string) {
  const out: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function diffSnapshots(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffMonths = new Set<string>();
  let diffs = 0;
  for (const k of keys) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) {
      diffs++;
      diffMonths.add(k.split('/')[0]);
    }
  }
  return { cells: keys.size, diffs, months: [...diffMonths].sort().join(' ') };
}

async function addTestTransaction(
  page: Page,
  account: string,
  category: string,
  date: string,
  amount: number,
) {
  await send(page, 'transaction-add', {
    id: randomUUID(),
    account,
    date,
    amount,
    category,
    notes: 'scenariotest',
  });
}

const TITLES: Record<number, string> = {
  1: 'Label van de eerste periode',
  2: 'Testtransacties 19-09, 20-09, 19-10 en 20-10',
  3: 'Inkomsten 19-09 en 20-09 aan weerszijden van de startgrens',
  4: 'To Budget + categoriesaldi = on-budget-rekeningen',
  5: 'Overschot rolt door, overbesteding gaat van To Budget af',
  6: 'Activiteit Boodschappen in de eerste periode',
  7: '#template en Hold in de periodeweergave',
  8: 'Maandweergave laat kalenderdata intact',
  9: 'Export opent in standaard Actual (STOCK_IMAGE)',
  10: 'Verse client ziet de periodes na download van de server',
};

function writeReport() {
  for (let req = 1; req <= 10; req++) {
    if (!results.some(r => r.req === req)) {
      results.push({
        req,
        title: TITLES[req],
        verdict: 'UNVERIFIED',
        observed: {},
        note: 'niet bereikt: het scenario stopte eerder',
      });
    }
  }
  results.sort((a, b) => a.req - b.req);
  const meta = {
    date: TODAY,
    forkImage: process.env.FORK_IMAGE ?? '',
    stockImage: process.env.STOCK_IMAGE ?? '',
    periods: { frequency: 'monthly', startDate: START_DATE, P0, P1, P2 },
  };
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify({ meta, results }, null, 2),
  );
  const cell = (s: string) => s.replace(/\|/g, '/');
  const lines = [
    '# Scenariotest budgetperiodes',
    '',
    `Fork: ${meta.forkImage}; standaard: ${meta.stockImage}`,
    '',
    '| Eis | Oordeel | Controle | Waarnemingen | Toelichting |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(r => {
      const obs = Object.entries(r.observed)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join('; ');
      return `| ${r.req} | ${r.verdict} | ${r.title} | ${cell(obs)} | ${cell(r.note)} |`;
    }),
    '',
  ];
  writeFileSync(`${OUT}/results.md`, lines.join('\n'));
}

// ---------- het scenario ----------

// Ook bij een fout in de opzet een volledig rapport.
test.afterAll(() => writeReport());

test('scenariotest budgetperiodes', async ({ browser }) => {
  test.setTimeout(20 * 60_000);

  // --- fork: import en nulmeting in de maandweergave ---
  const fork = await signInAndImport(browser, FORK_URL, EXPORT_ZIP);
  const page = fork.page;
  await readNumberFormat(page);
  // Een latere export kan de periodeweergave al aan hebben staan.
  if (PERIOD_ID.test(await selectedMonth(page))) {
    await setPeriodView(page, false);
    await expect(page.getByTestId('selected-budget-month')).toHaveAttribute(
      'data-month',
      CALENDAR_ID,
    );
  }
  const bounds = await send<{ start: string; end: string }>(
    page,
    'get-budget-bounds',
  );
  const calMonths = monthRange(bounds.start, bounds.end);
  const before = await calendarBudgets(page, calMonths);
  await gotoMonth(page, '2026-09');
  const uiSepBudgetedBefore = await uiTotal(page, /total-budgeted$/);

  const ids = {
    groceries: await categoryId(page, CAT_GROCERIES),
    care: await categoryId(page, CAT_CARE),
    sport: await categoryId(page, CAT_SPORT),
  };
  const accounts = await send<
    Array<{ id: string; offbudget: number | boolean; closed: number | boolean }>
  >(page, 'accounts-get');
  const onBudget = accounts.find(a => !a.offbudget && !a.closed);
  if (!onBudget) {
    throw new Error('geen open on-budget-rekening in de export');
  }

  // --- periodes aanzetten: vlag, monthly, 2026-09-20, periodeweergave ---
  const settings = await new Navigation(page).goToSettingsPage();
  await settings.waitFor();
  await settings.enableExperimentalFeature('Pay periods');
  const freq = page.getByRole('button', {
    name: /^(Monthly|Weekly|Biweekly|Semimonthly)$/,
  });
  // Eerst een andere waarde, zodat 'monthly' echt als voorkeur wordt opgeslagen.
  await freq.click();
  await page
    .getByRole('button', { name: 'Weekly', exact: true })
    .last()
    .click();
  await freq.click();
  await page
    .getByRole('button', { name: 'Monthly', exact: true })
    .last()
    .click();
  await page.locator('input[type="date"]').fill(START_DATE);
  await expect
    .poll(async () => {
      const p = await send<Record<string, string>>(page, 'preferences/get');
      return `${p.payPeriodFrequency}|${p.payPeriodStartDate}`;
    })
    .toBe(`monthly|${START_DATE}`);

  await new Navigation(page).goToBudgetPage();
  await setPeriodView(page, true);
  await expect(page.getByTestId('selected-budget-month')).toHaveAttribute(
    'data-month',
    PERIOD_ID,
  );
  const currentPeriod = await selectedMonth(page);
  await gotoMonth(page, P1.id);

  // --- eis 1: label ---
  await check(page, 1, 'Label van de eerste periode', async obs => {
    const picker = (
      await page.getByTestId('selected-budget-month').innerText()
    ).trim();
    const header = (await summary(page, P1.id).innerText())
      .split('\n')[0]
      .trim();
    obs.currentPeriodId = currentPeriod;
    obs.pickerLabel = picker;
    obs.headerLabel = header;
    requireThat(
      currentPeriod === periodIdFor(TODAY),
      `huidige periode op ${TODAY} is ${currentPeriod}, verwacht ${periodIdFor(TODAY)}`,
    );
    // Vastgesteld labelformaat (UI-taal en-US): kop maand-dag, picker "Sep-1".
    requireThat(
      header === 'Sep 20 - Oct 19',
      `header "${header}" is niet "Sep 20 - Oct 19"`,
    );
    requireThat(picker === 'Sep-1', `picker "${picker}" is niet "Sep-1"`);
  });

  // --- eis 4: envelope-invariant, vóór alle testmutaties ---
  await check(
    page,
    4,
    'To Budget + categoriesaldi = on-budget-rekeningen',
    async obs => {
      const s = await sheet(page, P1.id);
      const toBudgetUi = await uiToBudget(page, P1.id);
      const balanceUi = await uiTotal(page, /total-leftover$/);
      const sidebar = parseAmount(
        await page.getByTestId('sidebar-on-budget-balance').innerText(),
      );
      const future = await txAggregate(page, {
        date: { $gt: TODAY },
        'account.offbudget': false,
      });
      const atEnd = await txAggregate(page, {
        date: { $lte: P1.end },
        'account.offbudget': false,
      });
      obs.toBudget = euro(toBudgetUi);
      obs.sumCategoryBalances = euro(balanceUi);
      obs.buffered = euro(s.buffered);
      obs.totalBudgetedP1 = euro(s['total-budgeted']);
      obs.onBudgetAccountsSidebar = euro(sidebar);
      obs.onBudgetAccountsAt1910 = euro(atEnd.sum);
      obs.transactionsAfterToday = future.count;
      obs.difference = euro(toBudgetUi + balanceUi - atEnd.sum);
      requireThat(
        toBudgetUi === s['to-budget'],
        'UI-To Budget wijkt af van het sheet',
      );
      requireThat(
        balanceUi === s['total-leftover'],
        'UI-saldi wijken af van het sheet',
      );
      requireThat(
        Math.abs(toBudgetUi + balanceUi - atEnd.sum) <= 1,
        `To Budget + saldi = ${euro(toBudgetUi + balanceUi)}, rekeningen = ${euro(atEnd.sum)}`,
      );
    },
  );

  // --- eis 10: verse client ziet de periodes (vóór alle testmutaties) ---
  await check(
    null,
    10,
    'Verse client ziet de periodes na download van de server',
    async obs => {
      const ref = await sheet(page, P1.id);
      const refUi = await uiIncome(page);
      // Prefs (vlag, frequentie, startdatum, weergave) naar de server.
      await send(page, 'sync');
      const fresh = await openFromServer(browser, FORK_URL);
      const fp = fresh.page;
      try {
        const freshBounds = await send<{ start: string; end: string }>(
          fp,
          'get-budget-bounds',
        );
        const freshSelected = await selectedMonth(fp);
        const fs = await sheet(fp, P1.id);
        obs.refIncomeP1 = euro(ref['total-income']);
        obs.refIncomeP1Ui = euro(refUi);
        obs.freshBounds = `${freshBounds.start}..${freshBounds.end}`;
        obs.freshSelectedMonth = freshSelected;
        obs.freshIncomeP1Sheet = euro(fs['total-income']);
        obs.freshSpentP1Sheet = euro(fs['total-spent']);
        let freshUi: number | null = null;
        if (PERIOD_ID.test(freshSelected)) {
          await gotoMonth(fp, P1.id);
          freshUi = await uiIncome(fp);
        }
        obs.freshIncomeP1Ui = euro(freshUi);
        obs.freshPageErrors = fresh.pageErrors.length;
        requireThat(
          refUi === ref['total-income'] && ref['total-income'] !== 0,
          'referentie-inkomsten in de eerste client zijn 0 of wijken af',
        );
        requireThat(
          PERIOD_ID.test(freshBounds.end),
          `verse client: budgetbereik eindigt op ${freshBounds.end}, geen periode-ID`,
        );
        requireThat(
          PERIOD_ID.test(freshSelected),
          `verse client: geselecteerd ${freshSelected}, geen periode`,
        );
        requireThat(
          fs['total-income'] === ref['total-income'],
          `verse client: inkomsten ${P1.id} ${euro(fs['total-income'])}, verwacht ${euro(ref['total-income'])}`,
        );
        requireThat(
          fs['total-spent'] === ref['total-spent'],
          `verse client: besteed ${P1.id} ${euro(fs['total-spent'])}, verwacht ${euro(ref['total-spent'])}`,
        );
        requireThat(
          freshUi === ref['total-income'],
          `verse client: UI-inkomsten ${euro(freshUi)}, verwacht ${euro(ref['total-income'])}`,
        );
      } catch (e) {
        mkdirSync(`${OUT}/failures`, { recursive: true });
        await fp
          .screenshot({ path: `${OUT}/failures/eis-10.png`, fullPage: true })
          .catch(() => undefined);
        throw e;
      } finally {
        await fresh.context.close();
      }
    },
  );

  // --- eis 3: inkomsten rond de startgrens 19-09 / 20-09 ---
  await check(
    page,
    3,
    'Inkomsten 19-09 en 20-09 aan weerszijden van de startgrens',
    async obs => {
      const income = (await categories(page)).find(c => c.is_income);
      if (!income) {
        throw new Error('geen inkomstencategorie voor de test-inkomsten');
      }
      const before0 = (await sheet(page, P0.id))['total-income'];
      const before1 = (await sheet(page, P1.id))['total-income'];
      await addTestTransaction(page, onBudget.id, income.id, '2026-09-19', 100);
      await addTestTransaction(page, onBudget.id, income.id, '2026-09-20', 100);
      await expect
        .poll(async () => (await sheet(page, P1.id))['total-income'], {
          timeout: 20_000,
          message: 'inkomsten eerste periode veranderden niet',
        })
        .not.toBe(before1);
      await expect
        .poll(async () => (await sheet(page, P0.id))['total-income'], {
          timeout: 20_000,
          message: 'inkomsten vorige periode veranderden niet',
        })
        .not.toBe(before0);
      const s0 = await sheet(page, P0.id);
      const s1 = await sheet(page, P1.id);
      const inc = (f: Record<string, unknown>) =>
        txAggregate(page, { ...f, 'category.is_income': true });
      const w0 = await inc(inPeriod(P0));
      const w1 = await inc(inPeriod(P1));
      // Eerste 'received'-cel in de tabel = totaalrij van de inkomsten.
      const ui1 = parseAmount(
        await page
          .getByTestId('budget-table')
          .getByTestId('received')
          .first()
          .innerText(),
      );
      obs.deltaIncomeP0 = euro(s0['total-income'] - before0);
      obs.deltaIncomeP1 = euro(s1['total-income'] - before1);
      obs.incomeP1UiEqualsSheet = ui1 === s1['total-income'];
      obs.incomeP0SheetEqualsTransactions = s0['total-income'] === w0.sum;
      obs.incomeP1SheetEqualsTransactions = s1['total-income'] === w1.sum;
      requireThat(
        s0['total-income'] - before0 === 100,
        `19-09 telde ${euro(s0['total-income'] - before0)} in de vorige periode`,
      );
      requireThat(
        s1['total-income'] - before1 === 100,
        `20-09 telde ${euro(s1['total-income'] - before1)} in de eerste periode`,
      );
      requireThat(
        ui1 === s1['total-income'],
        'UI-inkomsten eerste periode wijken af van het sheet',
      );
      requireThat(
        s1['total-income'] === w1.sum,
        'inkomsten eerste periode wijken af van transacties 20-09 t/m 19-10',
      );
      requireThat(
        s0['total-income'] === w0.sum,
        'inkomsten vorige periode wijken af van transacties 20-08 t/m 19-09',
      );
    },
  );

  // --- eis 2: grenzen 19-09 / 20-09 en 19-10 / 20-10 ---
  await check(
    page,
    2,
    'Testtransacties 19-09, 20-09, 19-10 en 20-10',
    async obs => {
      const key = `sum-amount-${ids.groceries}`;
      const b0 = (await sheet(page, P0.id))[key];
      const b1 = (await sheet(page, P1.id))[key];
      const b2 = (await sheet(page, P2.id))[key];
      for (const date of [
        '2026-09-19',
        '2026-09-20',
        '2026-10-19',
        '2026-10-20',
      ]) {
        await addTestTransaction(page, onBudget.id, ids.groceries, date, -100);
      }
      await expect
        .poll(async () => (await sheet(page, P2.id))[key], {
          timeout: 20_000,
          message: 'uitgaven tweede periode veranderden niet',
        })
        .not.toBe(b2);
      await expect
        .poll(async () => (await sheet(page, P0.id))[key], {
          timeout: 20_000,
          message: 'uitgaven vorige periode veranderden niet',
        })
        .not.toBe(b0);
      const a0 = (await sheet(page, P0.id))[key];
      const a1 = (await sheet(page, P1.id))[key];
      const a2 = (await sheet(page, P2.id))[key];
      const ui1 = parseAmount(
        await categoryRow(page, CAT_GROCERIES)
          .getByTestId('category-month-spent')
          .innerText(),
      );
      obs.deltaP0 = euro(a0 - b0);
      obs.deltaP1 = euro(a1 - b1);
      obs.deltaP2 = euro(a2 - b2);
      requireThat(ui1 === a1, 'UI-uitgaven wijken af van het sheet');
      requireThat(
        a0 - b0 === -100,
        `19-09 telde ${euro(a0 - b0)} in de vorige periode (verwacht -1.00)`,
      );
      requireThat(
        a1 - b1 === -200,
        `20-09 en 19-10 telden ${euro(a1 - b1)} in de eerste periode (verwacht -2.00)`,
      );
      requireThat(
        a2 - b2 === -100,
        `20-10 telde ${euro(a2 - b2)} in de tweede periode (verwacht -1.00)`,
      );
    },
  );

  // --- eis 6: doorklikken op activiteit ---
  await check(
    page,
    6,
    'Activiteit Boodschappen in de eerste periode',
    async obs => {
      const expected = await txDates(page, {
        category: ids.groceries,
        ...inPeriod(P1),
      });
      // Hoog venster, zodat de gevirtualiseerde tabel alle rijen rendert.
      await page.setViewportSize({ width: 1600, height: 5000 });
      await categoryRow(page, CAT_GROCERIES)
        .getByTestId('category-month-spent')
        .click();
      const table = page.getByTestId('transaction-table');
      await table.waitFor();
      await page.waitForTimeout(1500);
      const allDates = (
        await table.getByTestId('row').getByTestId('date').allInnerTexts()
      ).map(t => t.trim());
      obs.rowsWithoutDate = allDates.filter(t => !t).length;
      const iso = allDates.filter(Boolean).map(t => {
        const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) {
          throw new Error(`datumformaat onbekend (${t.length} tekens)`);
        }
        return `${m[3]}-${m[2]}-${m[1]}`;
      });
      const outside = iso.filter(d => d < P1.start || d > P1.end);
      obs.rowsShown = iso.length;
      obs.expectedTransactions = expected.count;
      obs.rowsOutsidePeriod = outside.length;
      obs.shows1909 = iso.includes('2026-09-19');
      obs.shows2009 = iso.includes('2026-09-20');
      obs.shows1910 = iso.includes('2026-10-19');
      obs.shows2010 = iso.includes('2026-10-20');
      obs.filterPills = await page
        .getByRole('button', { name: 'Delete filter' })
        .count();
      await page.setViewportSize({ width: 1600, height: 1400 });
      requireThat(
        outside.length === 0,
        `${outside.length} transacties buiten 20-09 t/m 19-10`,
      );
      requireThat(
        iso.length === expected.count,
        `lijst toont ${iso.length}, verwacht ${expected.count}`,
      );
      requireThat(iso.includes('2026-09-20'), 'testtransactie 20-09 ontbreekt');
      requireThat(iso.includes('2026-10-19'), 'testtransactie 19-10 ontbreekt');
    },
  );
  await page.setViewportSize({ width: 1600, height: 1400 });
  await new Navigation(page).goToBudgetPage();
  await gotoMonth(page, P1.id);

  // --- eis 5: overschot en overbesteding ---
  await check(
    page,
    5,
    'Overschot rolt door, overbesteding gaat van To Budget af',
    async obs => {
      const bp = new BudgetPage(page);
      const leftover = (s: Cells, id: string) => s[`leftover-${id}`];
      const carryIn = (s: Cells, id: string) =>
        s[`leftover-${id}`] - s[`budget-${id}`] - s[`sum-amount-${id}`];

      // Verzorging: +10 over aan het eind van de eerste periode.
      let s1 = await sheet(page, P1.id);
      const budgetCare =
        1000 - carryIn(s1, ids.care) - s1[`sum-amount-${ids.care}`];
      obs.careBudgetSetP1 = euro(budgetCare);
      await bp.setBudgetedAmount(CAT_CARE, amountInput(budgetCare));
      await waitForCell(page, P1.id, `budget-${ids.care}`, budgetCare);
      s1 = await sheet(page, P1.id);
      const s2 = await sheet(page, P2.id);
      obs.careLeftoverP1 = euro(leftover(s1, ids.care));
      obs.careCarryIntoP2 = euro(carryIn(s2, ids.care));

      // Sport: -20 zonder budget in de eerste periode. Een latere export
      // kan al een periodebudget hebben; dat zetten we eerst op 0.
      obs.sportBudgetP1Imported = euro(s1[`budget-${ids.sport}`]);
      if (s1[`budget-${ids.sport}`] !== 0) {
        await bp.setBudgetedAmount(CAT_SPORT, '0');
        await waitForCell(page, P1.id, `budget-${ids.sport}`, 0);
        s1 = await sheet(page, P1.id);
      }
      const sportBudget = s1[`budget-${ids.sport}`];
      const sportBefore = leftover(s1, ids.sport);
      const tb2Before = (await sheet(page, P2.id))['to-budget'];
      obs.sportBudgetP1 = euro(sportBudget);
      obs.sportLeftoverP1Before = euro(sportBefore);
      await addTestTransaction(
        page,
        onBudget.id,
        ids.sport,
        '2026-09-25',
        -2000,
      );
      await waitForCell(
        page,
        P1.id,
        `leftover-${ids.sport}`,
        sportBefore - 2000,
      );
      await gotoMonth(page, P2.id);
      await expect
        .poll(async () => (await sheet(page, P2.id))['to-budget'])
        .not.toBe(tb2Before);
      const tb2After = await uiToBudget(page, P2.id);
      await gotoMonth(page, P1.id);
      const overBefore = Math.max(0, -sportBefore);
      const overAfter = Math.max(0, -(sportBefore - 2000));
      const expectedDelta = -(overAfter - overBefore);
      obs.toBudgetP2Delta = euro(tb2After - tb2Before);
      obs.toBudgetP2DeltaExpected = euro(expectedDelta);
      requireThat(
        leftover(s1, ids.care) === 1000,
        'Verzorging eindigt de eerste periode niet op +10',
      );
      requireThat(
        carryIn(s2, ids.care) === 1000,
        `Verzorging begint de tweede periode met ${euro(carryIn(s2, ids.care))}`,
      );
      requireThat(
        sportBudget === 0,
        'Sport heeft al een budget in de eerste periode',
      );
      requireThat(
        tb2After - tb2Before === expectedDelta,
        `To Budget tweede periode veranderde ${euro(tb2After - tb2Before)}, verwacht ${euro(expectedDelta)}`,
      );
    },
  );

  // --- eis 7: template en hold ---
  await check(page, 7, '#template en Hold in de periodeweergave', async obs => {
    const bp = new BudgetPage(page);
    // Apply vult alleen categorieën zonder budget; zet Verzorging eerst op 0.
    await bp.setBudgetedAmount(CAT_CARE, '0');
    await waitForCell(page, P1.id, `budget-${ids.care}`, 0);
    await send(page, 'notes-save', { id: ids.care, note: '#template 20' });
    await summary(page, P1.id)
      .getByRole('button', { name: /menu/i })
      .first()
      .click();
    await page.getByRole('button', { name: 'Apply budget template' }).click();
    await waitForCell(page, P1.id, `budget-${ids.care}`, 2000);
    const uiCare = parseAmount(
      await categoryRow(page, CAT_CARE).getByTestId('budget').innerText(),
    );
    obs.careBudgetAfterTemplate = euro(uiCare);
    requireThat(uiCare === 2000, `template gaf ${euro(uiCare)}`);

    const hold = 500;
    let s1 = await sheet(page, P1.id);
    obs.toBudgetP1BeforeHold = euro(s1['to-budget']);
    if (s1['to-budget'] < hold) {
      // Hold kan alleen positief To Budget vasthouden: maak ruimte met een
      // test-inkomst in de eerste periode (alleen in deze wegwerpcontainer).
      const room = hold + 1000 - s1['to-budget'];
      const income = (await categories(page)).find(c => c.is_income);
      if (!income) {
        throw new Error('geen inkomstencategorie voor de test-inkomst');
      }
      await addTestTransaction(
        page,
        onBudget.id,
        income.id,
        '2026-09-26',
        room,
      );
      await waitForCell(page, P1.id, 'to-budget', hold + 1000);
      obs.testIncomeAdded = euro(room);
      s1 = await sheet(page, P1.id);
    }
    const tb2Before = (await sheet(page, P2.id))['to-budget'];
    await clickToBudget(page, P1.id);
    await page.getByRole('button', { name: /^Hold for next/ }).click();
    const holdForm = page
      .locator('form')
      .filter({ hasText: 'Hold this amount:' });
    const holdInput = holdForm.getByRole('textbox');
    // Het veld wordt na openen nog met het volledige To Budget gevuld;
    // wacht daarop en typ dan pas, zoals een gebruiker.
    await expect(holdInput).not.toHaveValue('');
    await page.waitForTimeout(500);
    await holdInput.click();
    await holdInput.press('ControlOrMeta+a');
    await holdInput.pressSequentially('5');
    await holdInput.press('Enter');
    await expect
      .poll(async () => (await sheet(page, P1.id)).buffered, {
        message: 'Hold veranderde buffered niet',
      })
      .not.toBe(s1.buffered);
    const after1 = await sheet(page, P1.id);
    const after2 = await sheet(page, P2.id);
    const held = after1.buffered - s1.buffered;
    await gotoMonth(page, P2.id);
    const tb2Ui = await uiToBudget(page, P2.id);
    await gotoMonth(page, P1.id);
    obs.held = euro(held);
    obs.toBudgetP1AfterHold = euro(after1['to-budget']);
    obs.fromLastPeriodP2 = euro(after2['from-last-month']);
    obs.toBudgetP2Delta = euro(after2['to-budget'] - tb2Before);
    if (held !== hold) {
      throw new Error(`hold-invoer niet als 5,00 verwerkt (${euro(held)})`);
    }
    requireThat(
      after1['to-budget'] === s1['to-budget'] - held,
      'To Budget eerste periode daalde niet met het vastgehouden bedrag',
    );
    // Het vastgehouden bedrag komt in de tweede periode binnen: het telt mee
    // in "from last month", en To Budget daar blijft gelijk (zonder Hold was
    // hetzelfde bedrag als restant van To Budget doorgeschoven).
    requireThat(
      after2['from-last-month'] === after1['to-budget'] + held,
      `tweede periode ontving ${euro(after2['from-last-month'])}, verwacht ${euro(after1['to-budget'] + held)}`,
    );
    requireThat(
      after2['to-budget'] === tb2Before,
      `To Budget tweede periode veranderde ${euro(after2['to-budget'] - tb2Before)}`,
    );
    requireThat(
      tb2Ui === after2['to-budget'],
      'UI-To Budget tweede periode wijkt af van het sheet',
    );
  });

  // --- export voor eis 9: met periodebudgetten en periodeweergave aan ---
  let exportPath = '';
  try {
    const st = await new Navigation(page).goToSettingsPage();
    await st.waitFor();
    const download = page.waitForEvent('download');
    await st.exportData();
    // In de container, niet in /out: de export bevat het hele budget.
    exportPath = '/tmp/fork-export.zip';
    await (await download).saveAs(exportPath);
  } catch (e) {
    exportPath = '';
    log(`export mislukt: ${String((e as Error).message).split('\n')[0]}`);
  }

  // --- eis 8: terug naar de maandweergave ---
  await check(page, 8, 'Maandweergave laat kalenderdata intact', async obs => {
    await new Navigation(page).goToBudgetPage();
    await setPeriodView(page, false);
    await expect(page.getByTestId('selected-budget-month')).toHaveAttribute(
      'data-month',
      CALENDAR_ID,
    );
    await gotoMonth(page, '2026-09');
    const after = await calendarBudgets(page, calMonths);
    const d = diffSnapshots(before, after);
    const uiSep = await uiTotal(page, /total-budgeted$/);
    obs.calendarMonths = `${calMonths[0]}..${calMonths[calMonths.length - 1]}`;
    obs.cellsCompared = d.cells;
    obs.cellsDifferent = d.diffs;
    obs.monthsDifferent = d.months || null;
    obs.sepBudgetedUi = `${euro(uiSepBudgetedBefore)} -> ${euro(uiSep)}`;
    obs.forkPageErrors = fork.pageErrors.length;
    requireThat(
      d.diffs === 0,
      `${d.diffs} kalenderbudgetten veranderd (${d.months})`,
    );
    requireThat(uiSep === uiSepBudgetedBefore, 'UI-totaal september veranderd');
  });

  // --- eis 9: dezelfde export in standaard Actual ---
  let stockPage: Page | null = null;
  await check(
    null,
    9,
    'Export opent in standaard Actual (STOCK_IMAGE)',
    async obs => {
      if (!exportPath) {
        throw new Error('geen export uit de fork');
      }
      const stock = await signInAndImport(browser, STOCK_URL, exportPath);
      stockPage = stock.page;
      const sp = stock.page;
      const selected = await selectedMonth(sp);
      const stockBounds = await send<{ start: string; end: string }>(
        sp,
        'get-budget-bounds',
      );
      const d = diffSnapshots(before, await calendarBudgets(sp, calMonths));
      const shownMonths = await sp
        .locator('[data-month]')
        .evaluateAll(els => els.map(e => e.getAttribute('data-month') ?? ''));
      const periodIds = shownMonths.filter(m => PERIOD_ID.test(m));
      const errorTexts = await sp.getByText(/error/i).count();
      obs.selectedMonth = selected;
      obs.bounds = `${stockBounds.start}..${stockBounds.end}`;
      obs.pageErrors = stock.pageErrors.length;
      obs.errorTexts = errorTexts;
      obs.cellsCompared = d.cells;
      obs.cellsDifferent = d.diffs;
      obs.periodIdsVisible = periodIds.length;
      obs.showPayPeriodsToggle = await sp
        .getByLabel('Show pay periods')
        .count();
      requireThat(
        stock.pageErrors.length === 0,
        `paginafout: ${stock.pageErrors[0]}`,
      );
      requireThat(errorTexts === 0, 'foutmelding zichtbaar');
      requireThat(CALENDAR_ID.test(selected), `geselecteerd: ${selected}`);
      requireThat(periodIds.length === 0, 'periode-ID zichtbaar');
      requireThat(
        d.diffs === 0,
        `${d.diffs} kalenderbudgetten wijken af (${d.months})`,
      );
    },
  );
  if (stockPage && results.find(r => r.req === 9)?.verdict !== 'PASS') {
    mkdirSync(`${OUT}/failures`, { recursive: true });
    await (stockPage as Page)
      .screenshot({ path: `${OUT}/failures/eis-9.png`, fullPage: true })
      .catch(() => undefined);
  }

  expect(
    results
      .filter(r => r.verdict !== 'PASS')
      .map(r => `eis ${r.req}: ${r.verdict}`),
  ).toEqual([]);
});
