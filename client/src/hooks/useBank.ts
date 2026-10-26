import { useEffect } from 'react'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNow } from '@/hooks/useNow'
import * as api from '@/lib/api'
import { ruleMap } from '@/lib/categories'
import { msUntilNextTick, statusCheckDue } from '@/lib/expiry'
import { msUntil } from '@/lib/format'

// Bank data changes slowly and every fetch is a call to the bank (some limit how often apps may
// read an account), so don't refetch it on every tab switch.
const BANK_QUERY_OPTIONS = {
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
}

// The bank directory barely changes; the server caches it for an hour too.
const DIRECTORY_QUERY_OPTIONS = {
  staleTime: 60 * 60 * 1000,
  refetchOnWindowFocus: false,
}

export function useCountries() {
  return useQuery({ queryKey: ['countries'], queryFn: api.getCountries, ...DIRECTORY_QUERY_OPTIONS })
}

export function useBanks(country: string) {
  return useQuery({
    queryKey: ['banks', country],
    queryFn: () => api.getBanks(country),
    enabled: country !== '',
    ...DIRECTORY_QUERY_OPTIONS,
  })
}

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: api.getStatus })
}

// The time left until `validUntil` by the server's clock (null if unknown, negative once passed),
// kept current for the connection bar: it re-renders just when what the bar shows changes or a
// check with the server falls due (lib/expiry.ts). Once valid_until has passed, /status is asked
// again on that schedule, so the app switches to the read-only "has expired" view by itself.
// Everything is worked out from the wall clock at each tick, not from a long timer, which can be
// paused while the computer sleeps. Never while a check is already on its way, so a slow one isn't
// restarted. /status also refetches when the tab regains focus.
export function useExpiryClock(validUntil: string | null): number | null {
  const queryClient = useQueryClient()
  const status = useStatus()
  // When /status last answered or failed, by the browser's clock (0: never).
  const checkedAt = Math.max(status.dataUpdatedAt, status.errorUpdatedAt)
  const { isFetching } = status

  // The times expiry.ts works from, at a moment by the browser's clock.
  const timesAt = (browserNow: Date) => ({
    msLeft: validUntil ? msUntil(validUntil, api.serverClock(browserNow)) : null,
    sinceLastCheckMs: checkedAt === 0 ? Infinity : browserNow.getTime() - checkedAt,
  })
  // Re-checked whenever /status answers, e.g. on focus after the computer slept.
  const browserNow = useNow((shown) => msUntilNextTick(timesAt(shown)), checkedAt)
  const times = timesAt(browserNow)
  const due = !isFetching && statusCheckDue(times)

  // On each tick (`browserNow`) while one is due, so a check that somehow didn't start is retried.
  useEffect(() => {
    if (due) void queryClient.refetchQueries({ queryKey: ['status'], exact: true }, { cancelRefetch: false })
  }, [due, browserNow, queryClient])

  return times.msLeft
}

// `onDisconnected` runs once the connection is gone, e.g. to clear messages about it.
export function useDisconnect({ onDisconnected }: { onDisconnected?: () => void } = {}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.disconnect,
    onSuccess: () => {
      // Switch to the disconnected view first, so the account queries are unmounted
      // before they're removed (otherwise they refetch and flash a "no session" error).
      queryClient.setQueryData(['status'], (status: api.Status | undefined) =>
        status && { ...status, connected: false, ended: null, validUntil: null },
      )
      queryClient.removeQueries({ queryKey: ['accounts'] })
      onDisconnected?.()
    },
  })
}

export type Disconnect = ReturnType<typeof useDisconnect>

export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: api.getAccounts, ...BANK_QUERY_OPTIONS })
}

// Not `enabled` once the bank connection has ended: balances only ever come live from the bank.
export function useBalances(accountUid: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['accounts', accountUid, 'balances'],
    queryFn: () => api.getBalances(accountUid),
    enabled,
    ...BANK_QUERY_OPTIONS,
  })
}

export function useTransactions(accountUid: string) {
  return useQuery({
    queryKey: ['accounts', accountUid, 'transactions'],
    queryFn: () => api.getTransactions(accountUid),
    ...BANK_QUERY_OPTIONS,
  })
}

// Saving or removing a budget or category rule writes the result straight into the cached list,
// so it changes without a refetch. First any fetch of the list still on its way is cancelled: it
// may have left before the save, and its older answer would otherwise overwrite it. If there's no
// list to update (it never loaded, e.g. it failed), the whole list is fetched instead, since
// writing just this one entry would hide all the others.
export async function updateCachedList<T>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  update: (list: T[]) => T[],
): Promise<void> {
  await queryClient.cancelQueries({ queryKey, exact: true })
  if (queryClient.getQueryData<T[]>(queryKey) === undefined) {
    await queryClient.invalidateQueries({ queryKey, exact: true })
    return
  }
  queryClient.setQueryData<T[]>(queryKey, (list) => list && update(list))
}

// Budgets and category rules live on our server, not the bank, so they're cheap to read: unlike
// bank data they use the default refetching (on mount and when the tab regains focus), which keeps
// two open tabs in step.
const budgetsKey = (accountUid: string) => ['accounts', accountUid, 'budgets'] as const

export function useBudgets(accountUid: string) {
  return useQuery({ queryKey: budgetsKey(accountUid), queryFn: () => api.getBudgets(accountUid) })
}

export function useSetBudget(accountUid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ category, amount }: { category: string; amount: number }) =>
      api.setBudget(accountUid, category, amount),
    onSuccess: (saved) =>
      updateCachedList<api.Budget>(queryClient, budgetsKey(accountUid), (budgets) => [
        ...budgets.filter((budget) => budget.category !== saved.category),
        saved,
      ]),
  })
}

export function useDeleteBudget(accountUid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (category: string) => api.deleteBudget(accountUid, category),
    onSuccess: (_result, category) =>
      updateCachedList<api.Budget>(queryClient, budgetsKey(accountUid), (budgets) =>
        budgets.filter((budget) => budget.category !== category),
      ),
  })
}

const categoryRulesKey = (accountUid: string) => ['accounts', accountUid, 'categoryRules'] as const

// The user's own categories, ready for categorize(). The cache keeps the server's list (which the
// mutations below update); `select` turns it into a CategoryRules map once per change of that list,
// shared by every component that asks.
export function useCategoryRules(accountUid: string) {
  return useQuery({
    queryKey: categoryRulesKey(accountUid),
    queryFn: () => api.getCategoryRules(accountUid),
    select: ruleMap,
  })
}

type RuleTarget = Pick<api.CategoryRule, 'direction' | 'payee'>

const sameTarget = (a: RuleTarget, b: RuleTarget) => a.direction === b.direction && a.payee === b.payee

export function useSetCategoryRule(accountUid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (rule: api.CategoryRule) => api.setCategoryRule(accountUid, rule),
    onSuccess: (saved) =>
      updateCachedList<api.CategoryRule>(queryClient, categoryRulesKey(accountUid), (rules) => [
        ...rules.filter((rule) => !sameTarget(rule, saved)),
        saved,
      ]),
  })
}

export function useDeleteCategoryRule(accountUid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (target: RuleTarget) => api.deleteCategoryRule(accountUid, target),
    onSuccess: (_result, target) =>
      updateCachedList<api.CategoryRule>(queryClient, categoryRulesKey(accountUid), (rules) =>
        rules.filter((rule) => !sameTarget(rule, target)),
      ),
  })
}

// The Refresh button: has the server check with the bank now, then shows the result everywhere
// the account's transactions are used.
export function useRefreshTransactions(accountUid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.getTransactions(accountUid, { refresh: true }),
    onSuccess: (data) => queryClient.setQueryData(['accounts', accountUid, 'transactions'], data),
    // If Refresh is what finds that the bank connection has ended, reload the transactions now:
    // the server answers from the saved copy, as of the last sync.
    onError: (error) => {
      if (error instanceof api.ApiError && error.code === api.SESSION_ENDED) {
        void queryClient.invalidateQueries({ queryKey: ['accounts', accountUid, 'transactions'] })
      }
    },
  })
}
