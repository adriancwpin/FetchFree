import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/lib/api'

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

export function useDisconnect() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.disconnect,
    onSuccess: () => {
      // Switch to the disconnected view first, so the account queries are unmounted
      // before they're removed (otherwise they refetch and flash a "no session" error).
      queryClient.setQueryData(['status'], (status: api.Status | undefined) =>
        status && { ...status, connected: false, validUntil: null },
      )
      queryClient.removeQueries({ queryKey: ['accounts'] })
    },
  })
}

export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: api.getAccounts, ...BANK_QUERY_OPTIONS })
}

export function useBalances(accountUid: string) {
  return useQuery({
    queryKey: ['accounts', accountUid, 'balances'],
    queryFn: () => api.getBalances(accountUid),
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

// Budgets live on our server, not the bank, so they're cheap to read and change.
export function useBudgets(accountUid: string) {
  return useQuery({ queryKey: ['accounts', accountUid, 'budgets'], queryFn: () => api.getBudgets(accountUid) })
}

// Saving and removing budgets update the cached list directly, so it changes without a refetch.
export function useSetBudget(accountUid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ category, amount }: { category: string; amount: number }) =>
      api.setBudget(accountUid, category, amount),
    onSuccess: (saved) =>
      queryClient.setQueryData(['accounts', accountUid, 'budgets'], (budgets: api.Budget[] | undefined) => [
        ...(budgets ?? []).filter((budget) => budget.category !== saved.category),
        saved,
      ]),
  })
}

export function useDeleteBudget(accountUid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (category: string) => api.deleteBudget(accountUid, category),
    onSuccess: (_result, category) =>
      queryClient.setQueryData(['accounts', accountUid, 'budgets'], (budgets: api.Budget[] | undefined) =>
        (budgets ?? []).filter((budget) => budget.category !== category),
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
  })
}
