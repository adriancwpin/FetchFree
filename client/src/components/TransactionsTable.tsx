import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useTransactions } from '@/hooks/useBank'
import type { Transaction } from '@/lib/api'
import { formatAmount } from '@/lib/format'
import { cn } from '@/lib/utils'

function describe(transaction: Transaction): string {
  const counterparty =
    transaction.credit_debit_indicator === 'CRDT' ? transaction.debtor?.name : transaction.creditor?.name
  return counterparty ?? transaction.remittance_information?.join(' ') ?? '—'
}

export function TransactionsTable({ accountUid }: { accountUid: string }) {
  const transactions = useTransactions(accountUid)

  if (transactions.isPending) {
    return <Skeleton className="h-32 w-full" />
  }
  if (transactions.isError) {
    return <p className="text-sm text-destructive">{transactions.error.message}</p>
  }
  if (transactions.data.length === 0) {
    return <p className="text-sm text-muted-foreground">No transactions.</p>
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
        {transactions.data.map((transaction, index) => {
          const isDebit = transaction.credit_debit_indicator === 'DBIT'
          const { amount, currency } = transaction.transaction_amount
          return (
            <TableRow key={transaction.entry_reference ?? index}>
              <TableCell className="tabular-nums">
                {transaction.booking_date ?? transaction.value_date ?? '—'}
              </TableCell>
              <TableCell className="max-w-64 truncate">{describe(transaction)}</TableCell>
              <TableCell
                className={cn('text-right tabular-nums', isDebit ? 'text-destructive' : 'text-emerald-600')}
              >
                {isDebit ? '−' : '+'}
                {formatAmount(amount, currency)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
