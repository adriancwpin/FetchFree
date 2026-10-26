import { type ReactNode, useState } from 'react'
import { Clock, Loader2, PlugZap } from 'lucide-react'
import { ConnectBank } from '@/components/ConnectBank'
import { Button, buttonVariants } from '@/components/ui/button'
import type { Disconnect } from '@/hooks/useBank'
import { bankLoginHref, type Status } from '@/lib/api'
import { cn } from '@/lib/utils'

const TONES = {
  // The connection expires soon but still works.
  warning: {
    box: 'border-amber-500/40 bg-amber-500/5',
    icon: Clock,
    iconClass: 'text-amber-700 dark:text-amber-400',
  },
  // The connection can't be used any more.
  ended: {
    box: 'border-destructive/40 bg-destructive/5',
    icon: PlugZap,
    iconClass: 'text-destructive',
  },
}

// True for every way back (see below), so said once, after each notice's own detail.
const KEPT = 'Your saved data, budgets and categories are kept.'

// The card ConnectionBar shows when the connection expires soon or has ended. Every way back
// is a new bank login, which only replaces the connection once it succeeds: if it fails or is
// cancelled, the current connection (and this card) stay as they were, and saved data is kept
// either way. Reconnect logs in to the same bank. Choosing a bank opens the bank picker here, for a
// connection made before the bank was recorded, or to switch banks. Disconnect, the one action that
// ends the connection straight away, is separate; its mutation is passed in, so the caller can
// share it (ConnectionBar shows one Disconnect whichever way it's drawn).
export function ConnectionNotice({
  tone,
  status,
  title,
  detail,
  disconnect,
}: {
  tone: keyof typeof TONES
  status: Status
  title: ReactNode
  // What happens next. Said differently when there's no bank to reconnect (see above). What's kept
  // is added after it.
  detail: { reconnect: ReactNode; chooseAgain: ReactNode }
  disconnect: Disconnect
}) {
  const [choosing, setChoosing] = useState(false)
  const { bank, loginUrl } = status
  const { box, icon: Icon, iconClass } = TONES[tone]

  return (
    <div className="flex w-full flex-col gap-4">
      {/* Screen readers are told once the connection has ended, not about each change of the
          warning's countdown. Always present (empty while warning), since a live region that
          appears together with its text often isn't read out. */}
      <p className="sr-only" role="status">
        {tone === 'ended' ? title : null}
      </p>
      <div className={cn('flex w-full flex-col gap-3 rounded-lg border p-4', box)}>
        <div className="flex items-start gap-3">
          <Icon className={cn('mt-0.5 size-5 shrink-0', iconClass)} aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-sm text-muted-foreground">
              {bank ? detail.reconnect : detail.chooseAgain} {KEPT}
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
            aria-expanded={choosing}
            onClick={() => setChoosing(!choosing)}
          >
            {bank ? 'Choose another bank' : 'Choose your bank'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            {disconnect.isPending && <Loader2 className="animate-spin" />}
            Disconnect
          </Button>
          {disconnect.isError && <span className="text-sm text-destructive">{disconnect.error.message}</span>}
        </div>
      </div>
      {choosing && <ConnectBank loginUrl={loginUrl} error={null} />}
    </div>
  )
}
