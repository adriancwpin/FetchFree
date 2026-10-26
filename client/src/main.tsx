import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { ApiError, onSessionEnded, SESSION_ENDED, type Status } from '@/lib/api'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // The server has recorded the connection as ended by the time it says so, so a retry is
        // answered from the saved copy (or says so again when there's nothing saved). One attempt
        // more than other errors get, so that retry happens even after an earlier failure.
        if (error instanceof ApiError && error.code === SESSION_ENDED) return failureCount < 3
        // Otherwise retry network failures and errors marked retryable (5xx) only; see ApiError.
        return failureCount < 2 && (!(error instanceof ApiError) || error.retryable)
      },
    },
  },
})

// Whenever a response says the bank connection has ended, refetch the status so the whole app
// switches to read-only with the "has ended" card. A status fetch already on its way
// may have started before the server knew, so the first notice restarts it. Later notices while
// that refetch is running wait for it instead: it started after the server knew, so it will see the
// end, and restarting it again would only delay the switch.
let statusRefetch: Promise<void> | null = null
onSessionEnded(() => {
  if (statusRefetch || queryClient.getQueryData<Status>(['status'])?.ended) return
  statusRefetch = queryClient.invalidateQueries({ queryKey: ['status'] }).finally(() => {
    statusRefetch = null
  })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
