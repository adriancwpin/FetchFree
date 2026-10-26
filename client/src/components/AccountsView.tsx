import { useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Budgets } from '@/components/Budgets'
import { CategoryBreakdown, CategoryFilterChip } from '@/components/CategoryBreakdown'
import { SpendingSummary } from '@/components/SpendingSummary'
import { TransactionsTable } from '@/components/TransactionsTable'
import { useAccounts, useBalances, useCategoryRules, useRefreshTransactions, useTransactions } from '@/hooks/useBank'
import { useNow } from '@/hooks/useNow'
import { type Account, type Balance, serverClock } from '@/lib/api'
import type { CategorySelection } from '@/lib/categories'
import { formatAmount, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

// `readOnly` once the bank connection has ended: saved data only, no balances, no Refresh.
// Budgets stay editable (they're our own data, not the bank's).
export function AccountsView({ readOnly = false }: { readOnly?: boolean }) {
  const accounts = useAccounts()

  if (accounts.isPending) {
    return <Skeleton className="h-28 w-full" />
  }
  if (accounts.isError) {
    return <p className="text-sm text-destructive">{accounts.error.message}</p>
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {accounts.data.map((account) => (
        <AccountCard key={account.uid} account={account} readOnly={readOnly} />
      ))}
    </div>
  )
}

// Banks return several balance types (ISO 20022 codes) in no fixed order. Prefer what the user can
// spend now, then the booked balance; anything else falls back to the first one listed.
const BALANCE_PREFERENCE = ['ITAV', 'CLAV', 'XPCD', 'ITBD', 'CLBD']
const BALANCE_LABELS: Record<string, string> = {
  ITAV: 'Available',
  CLAV: 'Available',
  FWAV: 'Available',
  XPCD: 'Expected',
  ITBD: 'Booked',
  CLBD: 'Booked',
  OPBD: 'Opening',
}

function primaryBalance(balances: Balance[] | undefined): Balance | undefined {
  if (!balances) return undefined
  for (const type of BALANCE_PREFERENCE) {
    const match = balances.find((balance) => balance.balance_type === type)
    if (match) return match
  }
  return balances[0]
}

function AccountCard({ account, readOnly }: { account: Account; readOnly: boolean }) {
  const [expanded, setExpanded] = useState(false)
  // The breakdown's Spending/Income choice, month and selected category, in one place: the breakdown
  // shows it and the table filters by it, so they stay in step (also across collapsing the card).
  const [selection, setSelection] = useState<CategorySelection>({ direction: 'out' })
  const balances = useBalances(account.uid, { enabled: !readOnly })
  const primary = primaryBalance(balances.data)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{account.name ?? account.product ?? 'Account'}</CardTitle>
        <CardDescription>{account.account_id?.iban ?? account.uid}</CardDescription>
        <CardAction className="flex flex-col items-end gap-1">
          {/* Checked first: a disabled query also counts as pending. */}
          {readOnly ? (
            <span className="text-sm text-muted-foreground">Balance not updated</span>
          ) : balances.isPending ? (
            <Skeleton className="h-6 w-24" />
          ) : balances.isError ? (
            <span className="text-sm text-destructive">{balances.error.message}</span>
          ) : primary ? (
            <>
              <span className="text-lg font-semibold tabular-nums">
                {formatAmount(primary.balance_amount.amount, primary.balance_amount.currency)}
              </span>
              {primary.balance_type && (
                <Badge variant="secondary" title={primary.balance_type}>
                  {BALANCE_LABELS[primary.balance_type] ?? primary.balance_type}
                </Badge>
              )}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">No balance</span>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronDown /> : <ChevronRight />}
            Activity
          </Button>
          {expanded && <SyncStatus accountUid={account.uid} readOnly={readOnly} />}
        </div>
        {expanded && (
          <>
            <SpendingSummary accountUid={account.uid} accountCurrency={account.currency ?? null} />
            <CategoryRulesError accountUid={account.uid} />
            <Budgets
              accountUid={account.uid}
              accountCurrency={account.currency ?? null}
              selection={selection}
              onSelectionChange={setSelection}
              readOnly={readOnly}
            />
            <CategoryBreakdown
              accountUid={account.uid}
              accountCurrency={account.currency ?? null}
              selection={selection}
              onSelectionChange={setSelection}
            />
            <CategoryFilterChip
              selection={selection}
              onClear={() => setSelection({ ...selection, category: undefined })}
            />
            <TransactionsTable
              accountUid={account.uid}
              accountCurrency={account.currency ?? null}
              selection={selection}
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}

// Budgets, the breakdown and the table fall back to the automatic categories if the user's own
// can't be loaded; this says so, once for all three, since budgets may then look off. Only when
// none were loaded: if a later refetch fails, the last ones loaded are still applied.
function CategoryRulesError({ accountUid }: { accountUid: string }) {
  const rules = useCategoryRules(accountUid)
  if (!rules.isError || rules.data !== undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-destructive" role="status">
      <span>Your own categories couldn't be loaded, so automatic ones are shown: {rules.error.message}</span>
      <Button variant="ghost" size="xs" disabled={rules.isFetching} onClick={() => void rules.refetch()}>
        Try again
      </Button>
    </div>
  )
}

// When the saved transactions were last checked with the bank, and a button to check now (not once
// the connection has ended: the banner above offers reconnecting instead).
function SyncStatus({ accountUid, readOnly }: { accountUid: string; readOnly: boolean }) {
  const transactions = useTransactions(accountUid)
  const refresh = useRefreshTransactions(accountUid)
  // Re-render every minute so "3 minutes ago" keeps up.
  const now = useNow(60_000)

  // While loading there's nothing to say yet. After a failed load, Refresh is the way to retry.
  if (transactions.isPending) return null
  const data = transactions.data
  // Only while nothing newer has arrived since the failed click (e.g. an automatic refetch).
  const refreshFailed = refresh.isError && refresh.submittedAt > transactions.dataUpdatedAt

  return (
    <div className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-1">
        {data && (
          <span>
            {/* lastSyncedAt is by the server's clock, so it's compared with that. */}
            {readOnly ? 'Last updated' : 'Updated'} {timeAgo(data.lastSyncedAt, serverClock(now))}
          </span>
        )}
        {!readOnly && (
          <Button variant="ghost" size="xs" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className={cn(refresh.isPending && 'animate-spin')} aria-hidden="true" />
            Refresh
          </Button>
        )}
      </div>
      {refreshFailed ? (
        <p className="text-destructive" role="status">
          Refresh failed: {refresh.error.message}
        </p>
      ) : (
        data?.syncError && (
          <p className="text-destructive" role="status">
            Couldn't reach your bank, so these are your saved transactions.
          </p>
        )
      )}
    </div>
  )
}
