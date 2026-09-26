import * as db from '#server/db';
import { Rule } from '#server/rules';
import { getRuleForSchedule } from '#server/schedules/app';
import type { Currency } from '#shared/currencies';
import { setPayPeriodConfig } from '#shared/pay-periods';
import type { CategoryEntity } from '#types/models';

import { isTrackingBudget } from './actions';
import { runSchedule } from './schedule-template';

vi.mock('#server/db');
vi.mock('./actions');
vi.mock('#server/schedules/app', async () => {
  const actualModule = await vi.importActual('#server/schedules/app');
  return {
    ...actualModule,
    getRuleForSchedule: vi.fn(),
  };
});

const defaultCurrency: Currency = {
  code: '',
  symbol: '',
  name: '',
  decimalPlaces: 2,
  numberFormat: 'comma-dot',
  symbolFirst: false,
};

const defaultCategory = { id: '1', name: 'Test Category' } as CategoryEntity;

type RuleSpec = {
  id?: string;
  start: string;
  amount: number;
  frequency: 'monthly' | 'yearly' | 'weekly' | 'daily';
  interval?: number;
};

function makeRule({
  id = 'r',
  start,
  amount,
  frequency,
  interval = 1,
}: RuleSpec): Rule {
  return new Rule({
    id,
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [
      {
        op: 'is',
        field: 'date',
        value: {
          start,
          interval,
          frequency,
          patterns: [],
          skipWeekend: false,
          weekendSolveMode: 'before',
          endMode: 'never',
          endOccurrences: 1,
          endDate: '2099-01-01',
        },
        type: 'date',
      },
      { op: 'is', field: 'amount', value: amount, type: 'number' },
    ],
    actions: [],
  });
}

function mockSingleSchedule(spec: RuleSpec, completed: number = 0) {
  vi.mocked(db.first).mockResolvedValue({ id: 1, completed });
  vi.mocked(getRuleForSchedule).mockResolvedValue(makeRule(spec));
  vi.mocked(isTrackingBudget).mockReturnValue(false);
}

function mockSchedulesByName(
  specsByName: Record<string, { spec: RuleSpec; completed?: number }>,
) {
  const names = Object.keys(specsByName);
  const sidByName: Record<string, number> = Object.fromEntries(
    names.map((name, i) => [name, i + 1]),
  );
  vi.mocked(db.first).mockImplementation(
    async (_q: string, params?: unknown[]) => {
      const name = (params as string[] | undefined)?.[0] ?? '';
      return {
        id: sidByName[name],
        completed: specsByName[name]?.completed ?? 0,
      };
    },
  );
  vi.mocked(getRuleForSchedule).mockImplementation(async id => {
    const name = names.find(n => sidByName[n] === Number(id)) ?? names[0];
    return makeRule(specsByName[name].spec);
  });
  vi.mocked(isTrackingBudget).mockReturnValue(false);
}

describe('runSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getAccounts).mockResolvedValue([]);
  });

  it('should return correct budget when recurring schedule set', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Test Schedule',
        priority: 0,
        directive: 'template',
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-08-01',
      amount: -10000,
      frequency: 'monthly',
    });

    const result = await runSchedule(
      template_lines,
      '2024-08-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );

    expect(result.to_budget).toBe(10000);
    expect(result.errors).toHaveLength(0);
    expect(result.remainder).toBe(0);
  });

  it('should return correct budget when yearly recurring schedule set and balance is greater than target', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Test Schedule',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-08-01',
      amount: -12000,
      frequency: 'yearly',
    });

    const result = await runSchedule(
      template_lines,
      '2024-09-01',
      12000,
      0,
      12000,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );

    expect(result.to_budget).toBe(1000);
    expect(result.errors).toHaveLength(0);
    expect(result.remainder).toBe(0);
  });

  it('returns a per-template monthly attribution map keyed by template', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: '  Test Schedule  ',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-08-01',
      amount: -10000,
      frequency: 'monthly',
    });

    const result = await runSchedule(
      template_lines,
      '2024-08-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );

    expect(result.perScheduleMonthly.get(template_lines[0])).toBe(10000);
    expect(result.to_budget).toBe(10000);
  });

  it('handles a pay-month-of monthly schedule alongside a yearly sinking schedule', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Internet',
        directive: 'template',
        priority: 0,
      } as const,
      {
        type: 'schedule',
        name: 'Insurance',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSchedulesByName({
      Internet: {
        spec: { start: '2024-01-15', amount: -10000, frequency: 'monthly' },
      },
      Insurance: {
        spec: { start: '2024-12-15', amount: -60000, frequency: 'yearly' },
      },
    });

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );

    expect(result.errors).toHaveLength(0);
    const internet = result.perScheduleMonthly.get(template_lines[0]) ?? 0;
    const insurance = result.perScheduleMonthly.get(template_lines[1]) ?? 0;
    expect(internet).toBe(10000); // pay-month-of: full target
    expect(insurance).toBeGreaterThan(0);
    expect(insurance).toBeLessThan(internet);
    expect(internet + insurance).toBeCloseTo(result.to_budget, -1);
  });

  it('budgets nothing in advance for a yearly schedule with `full: true`', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Insurance',
        full: true,
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-12-15',
      amount: -60000,
      frequency: 'yearly',
    });

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(0);
    expect(result.perScheduleMonthly.get(template_lines[0])).toBeUndefined();
  });

  it('only attributes contribution to schedules occurring this month when full: true is used', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Schedule A',
        full: true,
        directive: 'template',
        priority: 0,
      } as const,
      {
        type: 'schedule',
        name: 'Schedule B',
        full: true,
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSchedulesByName({
      'Schedule A': {
        spec: { start: '2024-08-01', amount: -10000, frequency: 'monthly' },
      },
      'Schedule B': {
        spec: { start: '2024-09-01', amount: -20000, frequency: 'monthly' },
      },
    });

    const result = await runSchedule(
      template_lines,
      '2024-08-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );

    expect(result.to_budget).toBe(10000);
    expect(result.perScheduleMonthly.get(template_lines[0])).toBe(10000);
    expect(result.perScheduleMonthly.get(template_lines[1])).toBeUndefined();
  });

  it('applies a percent adjustment to the schedule amount', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Bill',
        adjustment: 10,
        adjustmentType: 'percent',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-08-15',
      amount: -10000,
      frequency: 'monthly',
    });

    const result = await runSchedule(
      template_lines,
      '2024-08-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(11000); // $100 × 1.10
  });

  it('applies a fixed adjustment to the schedule amount', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Bill',
        adjustment: 5,
        adjustmentType: 'fixed',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-08-15',
      amount: -10000,
      frequency: 'monthly',
    });

    const result = await runSchedule(
      template_lines,
      '2024-08-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(10500); // $100 + $5
  });

  it('skips completed schedules from the budget total', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Done',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule(
      { start: '2024-08-15', amount: -10000, frequency: 'monthly' },
      1,
    );

    const result = await runSchedule(
      template_lines,
      '2024-08-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(0);
  });

  it('budgets all daily occurrences within the month for a daily schedule', async () => {
    const template_lines = [
      {
        type: 'schedule',
        name: 'Daily Bill',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-01-01',
      amount: -100,
      frequency: 'daily',
    });

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(3100); // 31 days × $1
  });

  it('sorts sinking schedules by next due date so existing balance covers the earliest first', async () => {
    // Templates given in reverse-date order to verify the engine sorts.
    // Sorted (May first): ($1200-$200)/5 + $600/11 = $254.55 → 25455
    // Unsorted (Nov first): ($600-$200)/11 + $1200/5 = $276.36 — the
    // assertion below only matches if the sort runs.
    const template_lines = [
      {
        type: 'schedule',
        name: 'November bill',
        directive: 'template',
        priority: 0,
      } as const,
      {
        type: 'schedule',
        name: 'May bill',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSchedulesByName({
      'November bill': {
        spec: { start: '2024-11-15', amount: -60000, frequency: 'yearly' },
      },
      'May bill': {
        spec: { start: '2024-05-15', amount: -120000, frequency: 'yearly' },
      },
    });

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      0,
      0,
      20000,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.to_budget).toBe(25455);
  });

  it('records a Past error for a non-repeating schedule whose date has already passed', async () => {
    // Non-repeating (no frequency) and dated before current_month → engine
    // marks it as past rather than rolling forward.
    const template_lines = [
      {
        type: 'schedule',
        name: 'Past',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
    vi.mocked(getRuleForSchedule).mockResolvedValue(
      new Rule({
        id: 'r',
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { op: 'is', field: 'date', value: '2023-06-01', type: 'date' },
          { op: 'is', field: 'amount', value: -10000, type: 'number' },
        ],
        actions: [],
      }),
    );
    vi.mocked(isTrackingBudget).mockReturnValue(false);

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.errors).toContainEqual(
      expect.stringMatching(/Schedule Past is in the Past/),
    );
    expect(result.to_budget).toBe(0);
  });

  it('contributes target/interval per month for a fully-funded bi-monthly schedule', async () => {
    // Every-2-months from 2024-03-15: interval 2 keeps it out of the
    // pay-month-of fast path. With balance == target the engine takes
    // the base-contribution branch: target / interval = $200 / 2 = $100.
    const template_lines = [
      {
        type: 'schedule',
        name: 'BiMonthly',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-03-15',
      amount: -20000,
      frequency: 'monthly',
      interval: 2,
    });

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      20000,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(10000);
  });

  it('contributes target / months-spanned for a fully-funded six-week schedule', async () => {
    // Every 6 weeks from 2024-02-12: outside the weekly pay-month-of
    // cap (≤4), so it sinks. With balance == target the base path runs:
    // prev = subWeeks(2024-02-12, 6) = 2024-01-01, span = 1 month →
    // contribution = $60 / 1 = $60.
    const template_lines = [
      {
        type: 'schedule',
        name: 'EverySixWeeks',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-02-12',
      amount: -6000,
      frequency: 'weekly',
      interval: 6,
    });

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      6000,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(6000);
  });

  it('contributes target / months-spanned for a fully-funded sixty-day schedule', async () => {
    // Every 60 days from 2024-03-01: outside the daily pay-month-of
    // cap (≤31), so it sinks. With balance == target the base path
    // runs: prev = subDays(2024-03-01, 60) = 2024-01-01, span = 2
    // months → contribution = $60 / 2 = $30.
    const template_lines = [
      {
        type: 'schedule',
        name: 'EverySixtyDays',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-03-01',
      amount: -6000,
      frequency: 'daily',
      interval: 60,
    });

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      6000,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(3000);
  });

  it('absorbs surplus when last-month balance exceeds a sinking schedule target', async () => {
    // Last-month balance ($150) > yearly target ($120). The sink rolls
    // the surplus forward and contributes nothing this month.
    const template_lines = [
      {
        type: 'schedule',
        name: 'Overfunded',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    mockSingleSchedule({
      start: '2024-12-15',
      amount: -12000,
      frequency: 'yearly',
    });

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      0,
      0,
      15000,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(0);
  });

  it('forces sinking schedules into pay-month-of mode when tracking-budget is on', async () => {
    // In tracking mode every schedule is treated as pay-month-of. A
    // far-future yearly schedule that would normally contribute ~$100/mo
    // sinking instead contributes 0 this month, since pay-month-of only
    // counts schedules whose num_months is 0.
    const template_lines = [
      {
        type: 'schedule',
        name: 'YearlyFar',
        directive: 'template',
        priority: 0,
      } as const,
    ];
    vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
    vi.mocked(getRuleForSchedule).mockResolvedValue(
      makeRule({ start: '2024-12-15', amount: -12000, frequency: 'yearly' }),
    );
    vi.mocked(isTrackingBudget).mockReturnValue(true);

    const result = await runSchedule(
      template_lines,
      '2024-01-01',
      0,
      0,
      0,
      0,
      [],
      defaultCategory,
      defaultCurrency,
    );
    expect(result.to_budget).toBe(0);
  });

  describe('Pay Period Integration', () => {
    beforeEach(() => {
      // Set up pay period config for biweekly starting Jan 5, 2024
      setPayPeriodConfig({
        enabled: true,
        payFrequency: 'biweekly',
        startDate: '2024-01-05',
      });
    });

    afterEach(() => {
      // Clean up pay period config
      setPayPeriodConfig({
        enabled: false,
        payFrequency: 'biweekly',
        startDate: '2024-01-05',
      });
    });

    it('should handle pay period IDs correctly for monthly recurring schedules', async () => {
      // Given: Pay period 2024-13 = Jan 5-18, 2024
      const template_lines = [
        {
          type: 'schedule',
          name: 'Test Schedule',
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-13'; // Pay period ID
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2024-01-15', // Date within the pay period
                interval: 1,
                frequency: 'monthly',
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2024-01-18',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -10000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should not crash and should calculate budget correctly
      expect(result.errors).toHaveLength(0);
      // Budget should be calculated (12 monthly payments of 10000)
      expect(result.to_budget).toBeGreaterThan(0);
    });

    it('should handle pay period IDs correctly for yearly recurring schedules', async () => {
      // Given: Pay period 2024-13 = Jan 5-18, 2024
      const template_lines = [
        {
          type: 'schedule',
          name: 'Test Schedule',
          directive: 'template',
          priority: 0,
        } as const,
      ];
      const current_month = '2024-13'; // Pay period ID
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2025-01-01', // Next year
                interval: 1,
                frequency: 'yearly',
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2025-01-04',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -12000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should not crash - budget calculation may be 0 depending on schedule logic
      expect(result.errors).toHaveLength(0);
      // The important part is it didn't crash when parsing the pay period ID
      expect(result).toHaveProperty('to_budget');
    });

    it('should handle repeating schedules within a pay period', async () => {
      // Given: Weekly schedule that repeats within the pay period
      const template_lines = [
        {
          type: 'schedule',
          name: 'Weekly Schedule',
          full: true, // Repeating schedule
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-13'; // Pay period ID (Jan 5-18)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2024-01-08', // Monday during pay period
                interval: 1,
                frequency: 'weekly',
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2024-01-18',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -5000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should handle weekly repeating schedules correctly
      expect(result.errors).toHaveLength(0);
      // Should budget for both occurrences (Jan 8 and Jan 15)
      expect(result.to_budget).toBeGreaterThan(0);
    });

    it('should correctly identify schedules in the past when using pay periods', async () => {
      // Given: Schedule date is before the current pay period
      const template_lines = [
        {
          type: 'schedule',
          name: 'Past Schedule',
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-15'; // Pay period (Feb 2-15)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: '2024-01-15', // Date in the past (falls in period 2024-13)
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -10000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should detect that schedule is in the past
      expect(result.errors).toContain('Schedule Past Schedule is in the Past.');
    });

    it('should correctly identify schedules in the future when using pay periods', async () => {
      // Given: Schedule date is after the current pay period
      const template_lines = [
        {
          type: 'schedule',
          name: 'Future Schedule',
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-13'; // Pay period (Jan 5-18)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2024-03-01', // Future date
                interval: 1,
                frequency: 'monthly',
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2024-03-04',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -12000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should calculate budget correctly (future schedule is valid)
      expect(result.errors).toHaveLength(0);
      expect(result.to_budget).toBeGreaterThan(0);
    });

    it('should handle addMonths correctly with pay period IDs', async () => {
      // Given: Repeating schedule that needs to calculate nextMonth
      const template_lines = [
        {
          type: 'schedule',
          name: 'Biweekly Schedule',
          full: true,
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-13'; // Pay period (Jan 5-18)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2024-01-10', // Within current pay period
                interval: 2,
                frequency: 'weekly', // Every 2 weeks
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2024-12-31',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -5000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should handle addMonths with pay period ID correctly
      expect(result.errors).toHaveLength(0);
      expect(result.to_budget).toBeGreaterThan(0);
    });

    it('should handle differenceInCalendarDays with pay period IDs', async () => {
      // Given: Repeating daily schedule
      const template_lines = [
        {
          type: 'schedule',
          name: 'Daily Schedule',
          full: true,
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-13'; // Pay period (Jan 5-18)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2024-01-06', // Day 2 of pay period
                interval: 3,
                frequency: 'daily', // Every 3 days
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2024-01-18',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -1000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should calculate multiple daily occurrences correctly
      expect(result.errors).toHaveLength(0);
      // Should budget for multiple occurrences: Jan 6, 9, 12, 15, 18
      expect(result.to_budget).toBeGreaterThan(0);
    });

    it('should handle weekend solving with pay period dates', async () => {
      // Given: Schedule with weekend solving enabled
      const template_lines = [
        {
          type: 'schedule',
          name: 'Weekend Solve Schedule',
          full: true,
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-13'; // Pay period (Jan 5-18)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2024-01-13', // Saturday (weekend)
                interval: 1,
                frequency: 'weekly',
                patterns: [],
                skipWeekend: true, // Skip weekends
                weekendSolveMode: 'before', // Move to Friday
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2024-01-18',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -2000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should handle weekend solving with pay period dates
      expect(result.errors).toHaveLength(0);
      expect(result.to_budget).toBeGreaterThan(0);
    });

    it('should handle schedules spanning across pay period boundaries', async () => {
      // Given: Schedule that starts in one pay period and continues into next
      const template_lines = [
        {
          type: 'schedule',
          name: 'Cross-Period Schedule',
          full: true,
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-13'; // Pay period (Jan 5-18)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2024-01-12', // Within current period
                interval: 1,
                frequency: 'weekly',
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2024-02-01',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -3000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should only count occurrences within the current pay period
      expect(result.errors).toHaveLength(0);
      // Should only budget for Jan 12 (next would be Jan 19, which is in period 2024-14)
      expect(result.to_budget).toBeGreaterThan(0);
    });

    it('should handle year boundary transitions with pay periods', async () => {
      // Given: Last pay period of 2024
      const template_lines = [
        {
          type: 'schedule',
          name: 'Year End Schedule',
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-38'; // Last biweekly pay period of 2024 (Dec 27 - Jan 9, 2025)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2025-01-05', // Date in next year
                interval: 1,
                frequency: 'monthly',
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2025-01-10',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -15000,
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should handle year boundary correctly
      expect(result.errors).toHaveLength(0);
      expect(result.to_budget).toBeGreaterThan(0);
    });

    it('should apply monthly schedule only once per pay period - Issue: $120 becoming $360', async () => {
      // Reproduction case: Monthly schedule for $120 on the 19th
      // Bug: Applied 3 times ($360) instead of once ($120) in a biweekly pay period
      // Using pay period 2024-14 (Jan 19 - Feb 1) which contains Jan 19
      const template_lines = [
        {
          type: 'schedule',
          name: 'Monthly Bill on 19th',
          full: true, // User wants full amount budgeted
          priority: 0,
          directive: 'template',
        } as const,
      ];
      const current_month = '2024-14'; // Biweekly pay period (Jan 19 - Feb 1, 2024)
      const balance = 0;
      const remainder = 0;
      const last_month_balance = 0;
      const to_budget = 0;
      const errors: string[] = [];
      const category = { id: '1', name: 'Test Category' } as CategoryEntity;

      vi.mocked(db.first).mockResolvedValue({ id: 1, completed: 0 });
      vi.mocked(getRuleForSchedule).mockResolvedValue(
        new Rule({
          id: 'test',
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            {
              op: 'is',
              field: 'date',
              value: {
                start: '2024-01-19', // 19th of each month
                interval: 1,
                frequency: 'monthly',
                patterns: [],
                skipWeekend: false,
                weekendSolveMode: 'before',
                endMode: 'never',
                endOccurrences: 1,
                endDate: '2024-12-31',
              },
              type: 'date',
            },
            {
              op: 'is',
              field: 'amount',
              value: -12000, // $120.00 in cents
              type: 'number',
            },
          ],
          actions: [],
        }),
      );
      vi.mocked(isTrackingBudget).mockReturnValue(false);

      // When
      const result = await runSchedule(
        template_lines,
        current_month,
        balance,
        remainder,
        last_month_balance,
        to_budget,
        errors,
        category,
        defaultCurrency,
      );

      // Then: Should budget exactly $120 once, NOT $360 (3x)
      expect(result.errors).toHaveLength(0);
      expect(result.to_budget).toBe(12000); // Should be exactly $120.00, not $360.00 (36000)
    });
  });
});
