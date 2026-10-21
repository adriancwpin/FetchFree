import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/lib/api'

export function useStatus() {
  return useQuery({ queryKey: ['status'], queryFn: api.getStatus })
}

export function useStartAuth() {
  return useMutation({
    mutationFn: api.startAuth,
    onSuccess: ({ url }) => {
      window.location.href = url
    },
  })
}

export function useDisconnect() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.disconnect,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['accounts'] })
      return queryClient.invalidateQueries({ queryKey: ['status'] })
    },
  })
}

export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: api.getAccounts })
}

export function useBalances(accountUid: string) {
  return useQuery({
    queryKey: ['accounts', accountUid, 'balances'],
    queryFn: () => api.getBalances(accountUid),
  })
}

export function useTransactions(accountUid: string) {
  return useQuery({
    queryKey: ['accounts', accountUid, 'transactions'],
    queryFn: () => api.getTransactions(accountUid),
  })
}
