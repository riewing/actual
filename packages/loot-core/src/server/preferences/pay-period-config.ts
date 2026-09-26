import * as db from '#server/db';
import { setPayPeriodConfig } from '#shared/pay-periods';
import type { PayPeriodConfig } from '#shared/pay-periods';

/**
 * Loads pay period configuration from synced preferences and updates the shared config.
 * This function handles validation and provides sensible defaults for invalid values.
 *
 * Kept free of other server modules so the budget code can call it without
 * import cycles.
 */
export async function loadPayPeriodConfig(): Promise<void> {
  const rows = await db.all<Pick<db.DbPreference, 'id' | 'value'>>(
    `SELECT id, value FROM preferences
      WHERE id IN ('showPayPeriods', 'payPeriodFrequency', 'payPeriodStartDate')`,
  );
  const prefs: Record<string, string | undefined> = {};
  for (const { id, value } of rows) {
    prefs[id] = value;
  }

  const config: PayPeriodConfig = {
    enabled: prefs.showPayPeriods === 'true',
    payFrequency:
      (prefs.payPeriodFrequency as PayPeriodConfig['payFrequency']) ||
      'monthly',
    startDate:
      prefs.payPeriodStartDate || new Date().toISOString().slice(0, 10),
  };

  // Validate frequency is one of the allowed values
  const validFrequencies: PayPeriodConfig['payFrequency'][] = [
    'weekly',
    'biweekly',
    'semimonthly',
    'monthly',
  ];
  if (!validFrequencies.includes(config.payFrequency)) {
    config.payFrequency = 'monthly';
  }

  // Validate startDate is a valid ISO date string
  if (config.startDate && isNaN(Date.parse(config.startDate))) {
    config.startDate = new Date().toISOString().slice(0, 10);
  }

  setPayPeriodConfig(config);
}
