import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { SpendingSummary } from '@/components/SpendingSummary'
import { TransactionsTable } from '@/components/TransactionsTable'
import { useAccounts, useBalances } from '@/hooks/useBank'
import type { Account } from '@/lib/api'
import { formatAmount } from '@/lib/format'

export function AccountsView() {
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
        <AccountCard key={account.uid} account={account} />
      ))}
    </div>
  )
}

function AccountCard({ account }: { account: Account }) {
  const [expanded, setExpanded] = useState(false)
  const balances = useBalances(account.uid)
  const primary = balances.data?.[0]

  return (
    <Card>
      <CardHeader>
        <CardTitle>{account.name ?? account.product ?? 'Account'}</CardTitle>
        <CardDescription>{account.account_id?.iban ?? account.uid}</CardDescription>
        <CardAction className="flex flex-col items-end gap-1">
          {balances.isPending ? (
            <Skeleton className="h-6 w-24" />
          ) : balances.isError ? (
            <span className="text-sm text-destructive">{balances.error.message}</span>
          ) : primary ? (
            <>
              <span className="text-lg font-semibold tabular-nums">
                {formatAmount(primary.balance_amount.amount, primary.balance_amount.currency)}
              </span>
              {primary.balance_type && <Badge variant="secondary">{primary.balance_type}</Badge>}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">No balance</span>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown /> : <ChevronRight />}
          Activity
        </Button>
        {expanded && (
          <>
            <SpendingSummary accountUid={account.uid} />
            <TransactionsTable accountUid={account.uid} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
