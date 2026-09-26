// @ts-strict-ignore
import React, { useEffect, useEffectEvent, useMemo, useState } from 'react';
import type { ComponentType } from 'react';

import { styles } from '@actual-app/components/styles';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import { applyPayPeriodPrefs } from '@actual-app/core/shared/pay-periods';
import type {
  CategoryEntity,
  CategoryGroupEntity,
} from '@actual-app/core/types/models';

import {
  useBudgetActions,
  useDeleteCategoryGroupMutation,
  useDeleteCategoryMutation,
  useReorderCategoryGroupMutation,
  useReorderCategoryMutation,
  useSaveCategoryGroupMutation,
  useSaveCategoryMutation,
  useSortCategoriesMutation,
} from '#budget';
import { useCategories } from '#hooks/useCategories';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useGlobalPref } from '#hooks/useGlobalPref';
import { useLocalPref } from '#hooks/useLocalPref';
import { useNavigate } from '#hooks/useNavigate';
import { createTransactionFilterConditions } from '#hooks/usePayPeriodTranslation';
import { SheetNameProvider } from '#hooks/useSheetName';
import { useSpreadsheet } from '#hooks/useSpreadsheet';
import { useSyncedPref } from '#hooks/useSyncedPref';

import { AutoSizingBudgetTable } from './DynamicBudgetTable';
import * as envelopeBudget from './envelope/EnvelopeBudgetComponents';
import { EnvelopeBudgetProvider } from './envelope/EnvelopeBudgetContext';
import * as trackingBudget from './tracking/TrackingBudgetComponents';
import { TrackingBudgetProvider } from './tracking/TrackingBudgetContext';
import { prewarmAllMonths, prewarmMonth } from './util';

export function Budget() {
  const currentMonth = monthUtils.currentMonth();
  const spreadsheet = useSpreadsheet();
  const navigate = useNavigate();
  const [summaryCollapsed, setSummaryCollapsedPref] = useLocalPref(
    'budget.summaryCollapsed',
  );
  const [startMonthPref, setStartMonthPref] = useLocalPref('budget.startMonth');
  const startMonth = startMonthPref || currentMonth;
  const [bounds, setBounds] = useState({
    start: startMonth,
    end: startMonth,
  });
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');
  const payPeriodFeatureFlagEnabled = useFeatureFlag('payPeriodsEnabled');
  const [payPeriodFrequency] = useSyncedPref('payPeriodFrequency');
  const [payPeriodStartDate] = useSyncedPref('payPeriodStartDate');
  const [payPeriodViewEnabled] = useSyncedPref('showPayPeriods');
  const [maxMonthsPref] = useGlobalPref('maxMonths');
  const maxMonths = maxMonthsPref || 1;
  const [initialized, setInitialized] = useState(false);
  const { data: { grouped: categoryGroups } = { grouped: [] } } =
    useCategories();

  const init = useEffectEvent(() => {
    async function run() {
      const { start, end } = await send('get-budget-bounds');
      setBounds({ start, end });

      await prewarmAllMonths(
        budgetType,
        spreadsheet,
        { start, end },
        startMonth,
      );

      setInitialized(true);
    }

    void run();
  });
  useEffect(() => init(), []);

  // Wire pay period config from synced prefs into month utils
  useEffect(() => {
    if (!payPeriodFeatureFlagEnabled) {
      applyPayPeriodPrefs({
        showPayPeriods: 'false',
        payPeriodFrequency: 'monthly',
        payPeriodStartDate: monthUtils.currentMonth(),
      });
      return;
    }

    // Use the existing validation function that handles type safety
    applyPayPeriodPrefs({
      showPayPeriods: payPeriodViewEnabled,
      payPeriodFrequency,
      payPeriodStartDate,
    });
  }, [
    payPeriodFeatureFlagEnabled,
    payPeriodViewEnabled,
    payPeriodFrequency,
    payPeriodStartDate,
  ]);

  // Reset view to current month when toggling between pay periods and calendar months
  useEffect(() => {
    if (!payPeriodFeatureFlagEnabled) {
      applyPayPeriodPrefs({
        showPayPeriods: 'false',
        payPeriodFrequency: 'monthly',
        payPeriodStartDate: monthUtils.currentMonth(),
      });
      return;
    }

    // Skip initial mount
    if (!initialized) {
      return;
    }

    if (payPeriodViewEnabled === 'false') {
      // When pay periods are disabled, reset to current calendar month
      // This ensures we don't have a pay period ID in startMonthPref
      const calendarMonth = monthUtils.currentMonth();
      setStartMonthPref(calendarMonth);
    } else if (payPeriodViewEnabled === 'true') {
      // When pay periods are enabled, reset to current pay period
      // This ensures we navigate to the correct pay period, not a stale calendar month
      const currentPayPeriod = monthUtils.currentMonth();
      setStartMonthPref(currentPayPeriod);
    }
  }, [
    payPeriodFeatureFlagEnabled,
    payPeriodViewEnabled,
    setStartMonthPref,
    initialized,
  ]);

  // Refresh budget bounds when pay period config changes or when toggling pay periods on
  useEffect(() => {
    // Skip if feature flag is disabled
    if (!payPeriodFeatureFlagEnabled) {
      return;
    }

    // Skip initial mount - only trigger on actual changes
    const isInitialMount = !initialized;
    if (isInitialMount) {
      return;
    }

    // Determine if we should refresh:
    // 1. Toggling pay periods on (to ensure pay period sheets exist)
    // 2. Config changes while pay periods are enabled (frequency or start date)
    const shouldRefresh =
      payPeriodViewEnabled === 'true' &&
      (payPeriodFrequency || payPeriodStartDate);

    if (shouldRefresh) {
      void send('get-budget-bounds').then(({ start, end }) => {
        setBounds({ start, end });
      });
    }
  }, [
    payPeriodFeatureFlagEnabled,
    payPeriodViewEnabled,
    payPeriodFrequency,
    payPeriodStartDate,
    initialized,
  ]);

  const loadBoundBudgets = useEffectEvent(() => {
    void send('get-budget-bounds').then(({ start, end }) => {
      if (bounds.start !== start || bounds.end !== end) {
        setBounds({ start, end });
      }
    });
  });
  useEffect(() => loadBoundBudgets(), []);

  const onMonthSelect = async (month, numDisplayed) => {
    setStartMonthPref(month);

    const warmingMonth = month;

    // We could be smarter about this, but this is a good start. We
    // optimize for the case where users press the left/right button
    // to move between months. This loads the month data all at once
    // and "prewarms" the spreadsheet cache. This uses a simple
    // heuristic that will fail if the user clicks an arbitrary month,
    // but it will just load in some unnecessary data.
    if (month < startMonth) {
      // pre-warm prev month
      await prewarmMonth(
        budgetType,
        spreadsheet,
        monthUtils.subMonths(month, 1),
      );
    } else if (month > startMonth) {
      // pre-warm next month
      await prewarmMonth(
        budgetType,
        spreadsheet,
        monthUtils.addMonths(month, numDisplayed),
      );
    }

    if (warmingMonth === month) {
      setStartMonthPref(month);
    }
  };

  const onToggleCollapse = () => {
    setSummaryCollapsedPref(!summaryCollapsed);
  };

  const onApplyBudgetTemplatesInGroup = async categories => {
    applyBudgetAction.mutate({
      month: startMonth,
      type: 'apply-multiple-templates',
      args: {
        categories,
      },
    });
  };

  const onShowActivity = (categoryId, month) => {
    const filterConditions = createTransactionFilterConditions(
      month,
      categoryId,
    );
    void navigate('/accounts', {
      state: {
        goBack: true,
        filterConditions,
        categoryId,
      },
    });
  };

  const saveCategory = useSaveCategoryMutation();
  const onSaveCategory = category => {
    saveCategory.mutate({ category });
  };
  const deleteCategory = useDeleteCategoryMutation();
  const onDeleteCategory = id => {
    deleteCategory.mutate({ id });
  };
  const reorderCategory = useReorderCategoryMutation();
  const saveCategoryGroup = useSaveCategoryGroupMutation();
  const onSaveCategoryGroup = group => {
    saveCategoryGroup.mutate({ group });
  };
  const deleteCategoryGroup = useDeleteCategoryGroupMutation();
  const onDeleteCategoryGroup = id => {
    deleteCategoryGroup.mutate({ id });
  };
  const reorderCategoryGroup = useReorderCategoryGroupMutation();
  const sortCategories = useSortCategoriesMutation();
  const applyBudgetAction = useBudgetActions();

  const onBudgetAction = (month, type, args) => {
    applyBudgetAction.mutate({ month, type, args });
  };

  // Derive the month to render based on pay period view toggle
  const derivedStartMonth = useMemo(() => {
    const config = monthUtils.getPayPeriodConfig();
    const usePayPeriods = config?.enabled;

    if (!usePayPeriods) return startMonth;

    // If already a pay period id, keep it
    const mm = parseInt(startMonth.slice(5, 7));
    if (Number.isFinite(mm) && mm >= 13) return startMonth;

    // For calendar months, use the current year for pay periods
    const currentYear = parseInt(startMonth.slice(0, 4));
    return String(currentYear) + '-13';
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- pay period config is module state; payPeriodViewEnabled signals its change
  }, [startMonth, payPeriodViewEnabled]);

  // With enhanced comparison functions, we can use original bounds
  // The getValidMonthBounds function will handle mixed types safely
  const derivedBounds = bounds;

  if (!initialized || !categoryGroups) {
    return null;
  }

  let table;
  if (budgetType === 'tracking') {
    table = (
      <TrackingBudgetProvider
        summaryCollapsed={summaryCollapsed}
        onBudgetAction={onBudgetAction}
        onToggleSummaryCollapse={onToggleCollapse}
      >
        <AutoSizingBudgetTable
          type={budgetType}
          prewarmStartMonth={derivedStartMonth}
          startMonth={derivedStartMonth}
          monthBounds={derivedBounds}
          maxMonths={maxMonths}
          onMonthSelect={onMonthSelect}
          onDeleteCategory={onDeleteCategory}
          onDeleteGroup={onDeleteCategoryGroup}
          onSaveCategory={onSaveCategory}
          onSaveGroup={onSaveCategoryGroup}
          onBudgetAction={onBudgetAction}
          onShowActivity={onShowActivity}
          onReorderCategory={reorderCategory.mutate}
          onReorderGroup={reorderCategoryGroup.mutate}
          onApplyBudgetTemplatesInGroup={onApplyBudgetTemplatesInGroup}
          onSortCategories={(groupId, direction) =>
            sortCategories.mutate({ groupId, direction })
          }
        />
      </TrackingBudgetProvider>
    );
  } else {
    table = (
      <EnvelopeBudgetProvider
        summaryCollapsed={summaryCollapsed}
        onBudgetAction={onBudgetAction}
        onToggleSummaryCollapse={onToggleCollapse}
      >
        <AutoSizingBudgetTable
          type={budgetType}
          prewarmStartMonth={derivedStartMonth}
          startMonth={derivedStartMonth}
          monthBounds={derivedBounds}
          maxMonths={maxMonths}
          onMonthSelect={onMonthSelect}
          onDeleteCategory={onDeleteCategory}
          onDeleteGroup={onDeleteCategoryGroup}
          onSaveCategory={onSaveCategory}
          onSaveGroup={onSaveCategoryGroup}
          onBudgetAction={onBudgetAction}
          onShowActivity={onShowActivity}
          onReorderCategory={reorderCategory.mutate}
          onReorderGroup={reorderCategoryGroup.mutate}
          onApplyBudgetTemplatesInGroup={onApplyBudgetTemplatesInGroup}
          onSortCategories={(groupId, direction) =>
            sortCategories.mutate({ groupId, direction })
          }
        />
      </EnvelopeBudgetProvider>
    );
  }

  return (
    <SheetNameProvider name={monthUtils.sheetForMonth(derivedStartMonth)}>
      {/*
        In a previous iteration, the wrapper needs `overflow: hidden` for
        some reason. Without it at certain dimensions the width/height
        that autosizer gives us is slightly wrong, causing scrollbars to
        appear. We might not need it anymore?
      */}
      <View
        style={{
          ...styles.page,
          paddingLeft: 8,
          paddingRight: 8,
          overflow: 'hidden',
        }}
      >
        <View style={{ flex: 1 }}>{table}</View>
      </View>
    </SheetNameProvider>
  );
}

export type BudgetSummaryProps = {
  month: string;
};

export type CategoryMonthProps = {
  month: string;
  category: CategoryEntity;
  editing: boolean;
  isLast?: boolean;
  onEdit: (id: CategoryEntity['id'] | null, month?: string) => void;
  onBudgetAction: (month: string, action: string, arg: unknown) => void;
  onShowActivity: (id: CategoryEntity['id'], month: string) => void;
};

export type CategoryGroupMonthProps = {
  month: string;
  group: CategoryGroupEntity;
};

export type BudgetComponents = {
  SummaryComponent: ComponentType<BudgetSummaryProps>;
  ExpenseCategoryComponent: ComponentType<CategoryMonthProps>;
  ExpenseGroupComponent: ComponentType<CategoryGroupMonthProps>;
  IncomeCategoryComponent: ComponentType<CategoryMonthProps>;
  IncomeGroupComponent: ComponentType<CategoryGroupMonthProps>;
  BudgetTotalsComponent: ComponentType;
  IncomeHeaderComponent: ComponentType;
};

export function useBudgetComponents(): BudgetComponents {
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');
  const envelopeComponents = useEnvelopeBudgetComponents();
  const trackingComponents = useTrackingBudgetComponents();

  return budgetType === 'envelope' ? envelopeComponents : trackingComponents;
}

function useTrackingBudgetComponents(): BudgetComponents {
  return useMemo(
    () => ({
      SummaryComponent: trackingBudget.BudgetSummary,
      ExpenseCategoryComponent: trackingBudget.ExpenseCategoryMonth,
      ExpenseGroupComponent: trackingBudget.ExpenseGroupMonth,
      IncomeCategoryComponent: trackingBudget.IncomeCategoryMonth,
      IncomeGroupComponent: trackingBudget.IncomeGroupMonth,
      BudgetTotalsComponent: trackingBudget.BudgetTotalsMonth,
      IncomeHeaderComponent: trackingBudget.IncomeHeaderMonth,
    }),
    [],
  );
}

function useEnvelopeBudgetComponents(): BudgetComponents {
  return useMemo(
    () => ({
      SummaryComponent: envelopeBudget.BudgetSummary,
      ExpenseCategoryComponent: envelopeBudget.ExpenseCategoryMonth,
      ExpenseGroupComponent: envelopeBudget.ExpenseGroupMonth,
      IncomeCategoryComponent: envelopeBudget.IncomeCategoryMonth,
      IncomeGroupComponent: envelopeBudget.IncomeGroupMonth,
      BudgetTotalsComponent: envelopeBudget.BudgetTotalsMonth,
      IncomeHeaderComponent: envelopeBudget.IncomeHeaderMonth,
    }),
    [],
  );
}
