export type PayPeriodPrefs = {
  showPayPeriods?: string;
  payPeriodFrequency?: string;
  payPeriodStartDate?: string;
};

/**
 * Whether a change in the pay period prefs requires `get-budget-bounds`.
 * That call makes the backend reload its pay period config and create the
 * matching (period or calendar) sheets, so it must run when pay periods are
 * turned on *or* off, and when the config changes while they are on.
 * `prev` is null for the first observation, where the initial load already
 * fetches the bounds.
 */
export function shouldRefreshBudgetBounds(
  prev: PayPeriodPrefs | null,
  next: PayPeriodPrefs,
): boolean {
  if (prev === null) {
    return false;
  }

  const wasEnabled = prev.showPayPeriods === 'true';
  const isEnabled = next.showPayPeriods === 'true';
  if (wasEnabled !== isEnabled) {
    return true;
  }
  if (!isEnabled) {
    return false;
  }

  return (
    prev.payPeriodFrequency !== next.payPeriodFrequency ||
    prev.payPeriodStartDate !== next.payPeriodStartDate
  );
}
