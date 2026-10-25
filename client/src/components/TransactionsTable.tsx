import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useTransactions } from '@/hooks/useBank'
import type { Transaction } from '@/lib/api'
import { CATEGORIES, type CategorySelection, categorize, transactionsFor } from '@/lib/categories'
import { formatUnsignedAmount } from '@/lib/format'
import { countedTransactions, dateOf, directionOf } from '@/lib/summary'
import { cn } from '@/lib/utils'

const DIRECTION_CLASSES = {
  in: 'text-emerald-600',
  out: 'text-destructive',
  none: 'text-muted-foreground',
}

// Shown next to transactions that aren't settled, so it's clear why the summary leaves them out.
const STATUS_LABELS: Record<string, string> = {
  PDNG: 'Pending',
  SCHD: 'Scheduled',
  HOLD: 'On hold',
  CNCL: 'Cancelled',
  RJCT: 'Rejected',
  INFO: 'Info',
}

// Banks return transactions in their own order (often oldest first, or by page).
function newestFirst(transactions: Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => (dateOf(b) ?? '').localeCompare(dateOf(a) ?? ''))
}

function describe(transaction: Transaction): string {
  const counterparty =
    directionOf(transaction) === 'in' ? transaction.debtor?.name : transaction.creditor?.name
  return counterparty ?? transaction.remittance_information?.join(' ') ?? '—'
}

// With a category selected, the table lists exactly the transactions the breakdown totalled for it
// (same direction, month, settlement and currency rules), so the rows add up to the amount clicked.
export function TransactionsTable({
  accountUid,
  accountCurrency = null,
  selection = null,
}: {
  accountUid: string
  accountCurrency?: string | null
  selection?: CategorySelection | null
}) {
  const transactions = useTransactions(accountUid)
  const rows = useMemo(() => {
    if (!transactions.data) return []
    const visible = selection?.category
      ? transactionsFor(countedTransactions(transactions.data, accountCurrency), selection)
      : transactions.data.transactions
    return newestFirst(visible)
  }, [transactions.data, accountCurrency, selection])

  if (transactions.isPending) {
    return <Skeleton className="h-32 w-full" />
  }
  if (transactions.isError) {
    return <p className="text-sm text-destructive">{transactions.error.message}</p>
  }
  if (transactions.data.transactions.length === 0) {
    return <p className="text-sm text-muted-foreground">No transactions.</p>
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No transactions in this category.</p>
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((transaction, index) => {
          const direction = directionOf(transaction)
          const { amount, currency } = transaction.transaction_amount
          const statusLabel = transaction.status ? STATUS_LABELS[transaction.status] : undefined
          const { label: categoryLabel, icon: CategoryIcon } = CATEGORIES[categorize(transaction)]
          return (
            // entry_reference isn't guaranteed unique across pages, so the index keeps keys distinct.
            <TableRow key={`${transaction.entry_reference ?? ''}-${index}`}>
              <TableCell className="tabular-nums">
                {dateOf(transaction) ?? '—'}
              </TableCell>
              <TableCell className="max-w-64">
                <div className="flex items-center gap-2">
                  <span className="truncate">{describe(transaction)}</span>
                  {statusLabel && <Badge variant="outline">{statusLabel}</Badge>}
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <CategoryIcon className="size-3" aria-hidden="true" />
                  {categoryLabel}
                </div>
              </TableCell>
              <TableCell className={cn('text-right tabular-nums', DIRECTION_CLASSES[direction ?? 'none'])}>
                {direction === 'out' ? '−' : direction === 'in' ? '+' : ''}
                {formatUnsignedAmount(amount, currency)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
