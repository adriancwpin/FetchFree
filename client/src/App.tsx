import { AccountsView } from '@/components/AccountsView'
import { ConnectBank } from '@/components/ConnectBank'
import { ConnectionBar } from '@/components/ConnectionBar'
import { Skeleton } from '@/components/ui/skeleton'
import { useStatus } from '@/hooks/useBank'

const CALLBACK_ERRORS: Record<string, string> = {
  invalid_state:
    'The bank login could not be verified (it may have expired or been started in another browser). Please try again.',
  no_accounts: 'The bank did not share any accounts.',
  session_failed: 'Could not complete the bank connection. Please try again.',
  missing_code: 'The bank did not return an authorization code.',
  start_failed: 'Could not start the bank login. Please try again.',
  unknown_bank: 'That bank isn’t available. Please pick one from the list.',
  // Sent by the bank when the user cancels on its consent page.
  access_denied: 'The bank login was cancelled.',
}

// The server's /callback redirects back here with ?connected=1 or ?error=<code>.
// Read once at load, outside React: it clears the URL, so it must not run again on re-render.
function readCallbackError(): string | null {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('error')
  if (params.has('error') || params.has('connected')) {
    window.history.replaceState(null, '', window.location.pathname)
  }
  if (!code) return null
  return CALLBACK_ERRORS[code] ?? `Bank connection failed (${code}).`
}

const callbackError = readCallbackError()

function App() {
  const status = useStatus()

  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col items-center gap-8 px-4 py-12">
      <h1 className="text-2xl font-semibold">Bank Sync Tracker</h1>
      {status.isPending ? (
        <Skeleton className="h-40 w-full max-w-sm" />
      ) : status.isError ? (
        <p className="text-sm text-destructive">Could not reach the server: {status.error.message}</p>
      ) : status.data.connected ? (
        <>
          <ConnectionBar validUntil={status.data.validUntil} bank={status.data.bank} />
          <AccountsView />
        </>
      ) : (
        <ConnectBank loginUrl={status.data.loginUrl} error={callbackError} />
      )}
    </div>
  )
}

export default App
