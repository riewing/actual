import { describe, expect, it } from 'vitest';

import { shouldRefreshBudgetBounds } from './payPeriodBounds';

const on = {
  showPayPeriods: 'true',
  payPeriodFrequency: undefined,
  payPeriodStartDate: '2026-09-20',
};
const off = { ...on, showPayPeriods: 'false' };

describe('shouldRefreshBudgetBounds', () => {
  it('does not refresh on the first observation (init loads bounds itself)', () => {
    expect(shouldRefreshBudgetBounds(null, on)).toBe(false);
    expect(shouldRefreshBudgetBounds(null, off)).toBe(false);
  });

  it('refreshes when pay periods are turned on', () => {
    expect(shouldRefreshBudgetBounds(off, on)).toBe(true);
    expect(
      shouldRefreshBudgetBounds(
        { showPayPeriods: undefined },
        { showPayPeriods: 'true' },
      ),
    ).toBe(true);
  });

  it('refreshes when pay periods are turned off', () => {
    expect(shouldRefreshBudgetBounds(on, off)).toBe(true);
    expect(
      shouldRefreshBudgetBounds(on, { ...on, showPayPeriods: undefined }),
    ).toBe(true);
  });

  it('refreshes when frequency or start date change while enabled', () => {
    expect(
      shouldRefreshBudgetBounds(on, { ...on, payPeriodFrequency: 'weekly' }),
    ).toBe(true);
    expect(
      shouldRefreshBudgetBounds(on, {
        ...on,
        payPeriodStartDate: '2026-10-01',
      }),
    ).toBe(true);
  });

  it('does not refresh when nothing relevant changed', () => {
    expect(shouldRefreshBudgetBounds(on, { ...on })).toBe(false);
    expect(shouldRefreshBudgetBounds(off, { ...off })).toBe(false);
  });

  it('does not refresh for config changes while disabled', () => {
    expect(
      shouldRefreshBudgetBounds(off, { ...off, payPeriodFrequency: 'weekly' }),
    ).toBe(false);
  });
});
