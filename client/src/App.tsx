import { useState } from 'react'
import { AccountsView } from '@/components/AccountsView'
import { ConnectBank } from '@/components/ConnectBank'
import { ConnectionBar } from '@/components/ConnectionBar'
import { Button } from '@/components/ui/button'
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
  const data = status.data
  // A failed login's message is about the connection it came back to: Disconnect ends that, so it
  // goes too (rather than reappearing in the bank picker). It can also be dismissed. A successful
  // login reloads the page, which clears it.
  const [loginError, setLoginError] = useState(callbackError)
  const clearLoginError = () => setLoginError(null)

  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col items-center gap-8 px-4 py-12">
      <h1 className="text-2xl font-semibold">Bank Sync Tracker</h1>
      {status.isPending ? (
        <Skeleton className="h-40 w-full max-w-sm" />
      ) : !data ? (
        <p className="text-sm text-destructive">Could not reach the server: {status.error?.message}</p>
      ) : (
        <>
          {/* A later check failed (e.g. the expiry check during a network blip): keep showing what
              was last known, rather than replacing the page; it's checked again later. */}
          {status.isError && (
            <p className="text-sm text-destructive" role="status">
              Couldn't check your bank connection with the server just now: {status.error.message}
            </p>
          )}
          {/* A login that failed or was cancelled while a connection exists (reconnecting early, or
              after it ended) leaves that connection as it was. The bank picker shows its own. */}
          {loginError && (data.connected || data.ended) && (
            <div className="flex w-full flex-wrap items-center gap-2 text-sm text-destructive" role="alert">
              <span>
                {loginError}{' '}
                {data.connected
                  ? "You're still connected as before."
                  : 'Nothing has changed: your saved data is still shown below.'}
              </span>
              <Button variant="ghost" size="xs" onClick={clearLoginError}>
                Dismiss
              </Button>
            </div>
          )}
          {data.connected || data.ended ? (
            // One branch for both, so the bar and the accounts stay put when the connection ends
            // (see ConnectionBar). Once it has ended, saved data stays visible, read-only.
            <>
              <ConnectionBar status={data} onDisconnected={clearLoginError} />
              <AccountsView readOnly={!data.connected} />
            </>
          ) : (
            <ConnectBank loginUrl={data.loginUrl} error={loginError} />
          )}
        </>
      )}
    </div>
  )
}

export default App
