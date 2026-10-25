import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { ApiError, type Status } from '@/lib/api'

// Whichever request first finds that the bank connection has ended: refetch the status, so the
// whole app switches to read-only with the "Reconnect your bank" banner, and the account data, so
// what failed is served from the saved copy instead. Only the first time, so a request that keeps
// failing (e.g. nothing saved) can't keep triggering refetches.
function onError(error: Error) {
  if (!(error instanceof ApiError) || error.code !== 'SESSION_ENDED') return
  if (queryClient.getQueryData<Status>(['status'])?.ended) return
  void queryClient.invalidateQueries({ queryKey: ['status'] })
  void queryClient.invalidateQueries({ queryKey: ['accounts'] })
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      // Retry network failures and errors marked retryable (5xx) only; see ApiError.
      retry: (failureCount, error) =>
        failureCount < 2 && (!(error instanceof ApiError) || error.retryable),
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
