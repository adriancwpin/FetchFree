import { Loader2, PlugZap } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { useDisconnect } from '@/hooks/useBank'
import { bankLoginHref, type EndReason, type Status } from '@/lib/api'

const ENDED_TEXT: Record<EndReason, string> = {
  expired: 'has expired',
  revoked: 'was revoked at your bank',
  closed: 'was closed by your bank',
  ended: 'has ended',
}

// Shown instead of the connection bar once the bank connection can't be used any more. The saved
// data below stays visible, read-only, until the user reconnects (same bank: history and budgets
// come back) or connects a different bank.
export function ReconnectBanner({ status }: { status: Status }) {
  const disconnect = useDisconnect()
  const { bank, loginUrl } = status

  return (
    <div role="status" className="flex w-full flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-start gap-3">
        <PlugZap className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            Your connection to {bank?.name ?? 'your bank'} {ENDED_TEXT[status.ended ?? 'ended']}.
          </p>
          <p className="text-sm text-muted-foreground">
            You're seeing your saved transactions; they won't update until you reconnect. Your budgets are kept.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:pl-8">
        {/* A navigation, not a fetch: the login starts on the server (see /login). */}
        {bank && (
          <a href={bankLoginHref(loginUrl, bank)} className={buttonVariants({ size: 'sm' })}>
            Reconnect {bank.name}
          </a>
        )}
        <Button
          variant={bank ? 'ghost' : 'default'}
          size="sm"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending && <Loader2 className="animate-spin" />}
          Connect a different bank
        </Button>
        {disconnect.isError && <span className="text-sm text-destructive">{disconnect.error.message}</span>}
      </div>
    </div>
  )
}
