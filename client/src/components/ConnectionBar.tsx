import { Loader2, Unplug } from 'lucide-react'
import { ConnectionNotice } from '@/components/ConnectionNotice'
import { Button } from '@/components/ui/button'
import { useDisconnect, useExpiryClock } from '@/hooks/useBank'
import type { EndReason, Status } from '@/lib/api'
import { expiresSoon } from '@/lib/expiry'
import { countryName, dateTime, timeLeft } from '@/lib/format'

const ENDED_TEXT: Record<EndReason, string> = {
  expired: 'has expired',
  revoked: 'was revoked at your bank',
  closed: 'was closed by your bank',
  ended: 'has ended',
}

const SAVED = "You're seeing your saved transactions; they won't update until you"

// The bank connection, for as long as there is one (App shows the bank picker otherwise):
//   - connected: "Connected to Nordea until 4 Nov 2026, 17:53" and Disconnect;
//   - in its last 2 days: a warning with the ways back (ConnectionNotice);
//   - ended (expired, revoked…): the same card, saying so, while the saved data below is read-only.
// The warning and the ended card are the same component in the same place, so when the warning
// turns into "has expired", an open bank picker and a Disconnect under way carry on; the one
// Disconnect is shared by all three for the same reason. Times are by the server's clock, which
// decides when the connection has expired.
export function ConnectionBar({ status, onDisconnected }: { status: Status; onDisconnected: () => void }) {
  const { validUntil, bank, ended } = status
  const disconnect = useDisconnect({ onDisconnected })
  // Only counted down (and checked with the server) while connected.
  const msLeft = useExpiryClock(ended ? null : validUntil)
  const until = validUntil ? dateTime(validUntil) : null
  const bankName = bank?.name ?? 'your bank'

  if (ended) {
    return (
      <ConnectionNotice
        tone="ended"
        status={status}
        title={`Your connection to ${bankName} ${ENDED_TEXT[ended]}.`}
        detail={{ reconnect: `${SAVED} reconnect.`, chooseAgain: `${SAVED} choose your bank and log in again.` }}
        disconnect={disconnect}
      />
    )
  }

  if (msLeft !== null && expiresSoon(msLeft)) {
    return (
      <ConnectionNotice
        tone="warning"
        status={status}
        title={
          msLeft > 0 ? (
            <>
              Your connection to {bankName} expires <span title={until ?? undefined}>{timeLeft(msLeft)}</span>.
            </>
          ) : (
            // Just passed: the server is being asked, and the read-only view follows.
            `Your connection to ${bankName} has expired.`
          )
        }
        detail={{
          reconnect: 'Reconnect now to keep your transactions updating.',
          chooseAgain: 'To keep your transactions updating, choose your bank and log in again.',
        }}
        disconnect={disconnect}
      />
    )
  }

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="text-sm text-muted-foreground">
        Connected
        {bank && (
          <>
            {' to '}
            <span className="font-medium text-foreground">{bank.name}</span> (
            {countryName(bank.country)})
          </>
        )}
        {until && ` until ${until}`}
      </p>
      <div className="flex items-center gap-3">
        {disconnect.isError && <span className="text-sm text-destructive">{disconnect.error.message}</span>}
        <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
          {disconnect.isPending ? <Loader2 className="animate-spin" /> : <Unplug />}
          Disconnect
        </Button>
      </div>
    </div>
  )
}
