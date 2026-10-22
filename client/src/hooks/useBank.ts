import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/lib/api'

// Bank data changes slowly and every fetch is a call to the bank (some limit how often apps may
// read an account), so don't refetch it on every tab switch.
const BANK_QUERY_OPTIONS = {
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
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
