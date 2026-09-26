import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '#server/db';
import * as sheet from '#server/sheet';
import { setPayPeriodConfig } from '#shared/pay-periods';

import { createAllBudgets } from './base';

const DISABLED = {
  enabled: false,
  payFrequency: 'monthly' as const,
  startDate: '2026-01-01',
};

function setPref(id: string, value: string) {
  // Straight into the table, like a pref arriving via sync: the in-memory
  // pay period config is not updated along the way.
  db.runQuery('INSERT INTO preferences (id, value) VALUES (?, ?)', [id, value]);
}

async function setupBudget() {
  await sheet.loadSpreadsheet(db);
  await db.insertCategoryGroup({ id: 'group1', name: 'Expenses' });
  await db.insertCategoryGroup({ id: 'group2', name: 'Income', is_income: 1 });
  await db.insertCategory({ name: 'Food', cat_group: 'group1' });
  await db.insertAccount({ id: 'acct', name: 'Bank' });
  await db.insertTransaction({
    date: '2026-06-24',
    amount: -1000,
    account: 'acct',
  });
}

function sheetHasCells(sheetName: string) {
  return [...sheet.get().getNodes().keys()].some(name =>
    name.startsWith(sheetName + '!'),
  );
}

describe('Budget range with pay period prefs changed via sync', () => {
  beforeEach(async () => {
    await global.emptyDatabase()();
    // Use the (frozen) clock: in tests currentMonth() otherwise ignores the
    // pay period config.
    global.IS_TESTING = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 24, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
    global.IS_TESTING = true;
    setPayPeriodConfig(DISABLED);
  });

  it('creates the current pay period when periods were enabled via sync', async () => {
    await setupBudget();
    setPref('showPayPeriods', 'true');
    setPref('payPeriodStartDate', '2026-09-20');
    // payPeriodFrequency is absent: the backend defaults to monthly.
    setPayPeriodConfig(DISABLED);

    const bounds = await createAllBudgets();
    await sheet.waitOnSpreadsheet();

    const { createdMonths } = sheet.get().meta();
    expect(createdMonths.has('2026-21')).toBe(true);
    expect(bounds.end > '2026-21').toBe(true);
    expect(sheetHasCells('budget202621')).toBe(true);
  });

  it('falls back to calendar months when periods were disabled via sync', async () => {
    await setupBudget();
    setPref('showPayPeriods', 'false');
    setPref('payPeriodStartDate', '2026-09-20');
    setPayPeriodConfig({
      enabled: true,
      payFrequency: 'monthly',
      startDate: '2026-09-20',
    });

    const bounds = await createAllBudgets();
    await sheet.waitOnSpreadsheet();

    const { createdMonths } = sheet.get().meta();
    expect(bounds).toEqual({ start: '2026-03', end: '2027-09' });
    expect(createdMonths.has('2026-09')).toBe(true);
    expect([...createdMonths].some(m => Number(m.slice(5, 7)) > 12)).toBe(
      false,
    );
  });
});
