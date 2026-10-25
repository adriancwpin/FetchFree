import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useCategoryRules, useDeleteCategoryRule, useSetCategoryRule, useTransactions } from '@/hooks/useBank'
import type { Transaction } from '@/lib/api'
import {
  CATEGORIES,
  type CategoryId,
  type CategorySelection,
  categorize,
  describe,
  type Payee,
  payeeOf,
  ruleFor,
  transactionsFor,
} from '@/lib/categories'
import { formatUnsignedAmount } from '@/lib/format'
import { countedTransactions, dateOf, directionOf } from '@/lib/summary'
import { cn, COMPACT_FIELD_CLASS } from '@/lib/utils'

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

function payeeId(payee: Payee): string {
  return `${payee.direction}:${payee.key}`
}

// Identifies a row across refetches, which replace every transaction object. Not unique (the bank
// may send no reference); it only decides which of a payee's rows the editor sits under.
function rowId(transaction: Transaction): string {
  return [transaction.entry_reference, dateOf(transaction), transaction.transaction_amount.amount].join('|')
}

// How many of the loaded transactions a rule for `payee` would apply to.
function countFrom(transactions: Transaction[], payee: Payee): number {
  return transactions.filter((transaction) => {
    const other = payeeOf(transaction)
    return other !== null && payeeId(other) === payeeId(payee)
  }).length
}

// With a category selected, the table lists exactly the transactions the breakdown totalled for it
// (same direction, month, settlement and currency rules), so the rows add up to the amount clicked.
// Clicking a transaction's category changes it for everything from that payee.
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
  const rules = useCategoryRules(accountUid)
  // Whose category is being changed, and from which row. Kept as text rather than the transaction
  // object, so a refetch (e.g. Refresh) doesn't close the editor.
  const [editing, setEditing] = useState<{ payee: string; row: string } | null>(null)
  const rows = useMemo(() => {
    if (!transactions.data) return []
    const visible = selection?.category
      ? transactionsFor(countedTransactions(transactions.data, accountCurrency), selection, rules.data)
      : transactions.data.transactions
    return newestFirst(visible)
  }, [transactions.data, accountCurrency, selection, rules.data])

  // The row the editor sits under: the one it was opened from, or if that's gone (e.g. a pending
  // transaction was booked) the first one from the same payee. None closes it.
  const editorIndex = useMemo(() => {
    if (!editing) return -1
    const samePayee = (transaction: Transaction) => {
      const payee = payeeOf(transaction)
      return payee !== null && payeeId(payee) === editing.payee
    }
    const opened = rows.findIndex((transaction) => samePayee(transaction) && rowId(transaction) === editing.row)
    return opened !== -1 ? opened : rows.findIndex(samePayee)
  }, [rows, editing])

  // Once none of the payee's rows are shown (e.g. a different filter), close the editor for good,
  // rather than have it reappear when they are again.
  const editorGone = editing !== null && transactions.data !== undefined && editorIndex === -1
  useEffect(() => {
    if (editorGone) setEditing(null)
  }, [editorGone])

  // Waits for the user's own categories too, so they don't change under the user once loaded.
  if (transactions.isPending || rules.isPending) {
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

  const allTransactions = transactions.data.transactions
  // One flat list, so the editor keeps its key (and the user's unsaved choice) when it moves rows.
  const body: ReactNode[] = []
  rows.forEach((transaction, index) => {
    const direction = directionOf(transaction)
    const { amount, currency } = transaction.transaction_amount
    const statusLabel = transaction.status ? STATUS_LABELS[transaction.status] : undefined
    const payee = payeeOf(transaction)
    const rule = ruleFor(transaction, rules.data)
    const category = rule ?? categorize(transaction)
    const { label: categoryLabel, icon: CategoryIcon } = CATEGORIES[category]
    const editorHere = index === editorIndex && payee !== null
    body.push(
      // entry_reference isn't guaranteed unique across pages, so the index keeps keys distinct.
      <TableRow key={`${transaction.entry_reference ?? ''}-${index}`}>
        <TableCell className="tabular-nums">
          {dateOf(transaction) ?? '—'}
        </TableCell>
        <TableCell className="max-w-64">
          <div className="flex items-center gap-2">
            <span className="truncate">{describe(transaction) ?? '—'}</span>
            {statusLabel && <Badge variant="outline">{statusLabel}</Badge>}
          </div>
          {payee ? (
            <button
              type="button"
              onClick={() => setEditing(editorHere ? null : { payee: payeeId(payee), row: rowId(transaction) })}
              aria-expanded={editorHere}
              aria-label={`Category: ${categoryLabel}${rule ? ', set by you' : ''}. Change it for ${payee.label}`}
              className="mt-0.5 -ml-1 flex items-center gap-1 rounded px-1 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <CategoryIcon className="size-3" aria-hidden="true" />
              {categoryLabel}
              {rule && <span aria-hidden="true">· yours</span>}
            </button>
          ) : (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <CategoryIcon className="size-3" aria-hidden="true" />
              {categoryLabel}
            </div>
          )}
        </TableCell>
        <TableCell className={cn('text-right tabular-nums', DIRECTION_CLASSES[direction ?? 'none'])}>
          {direction === 'out' ? '−' : direction === 'in' ? '+' : ''}
          {formatUnsignedAmount(amount, currency)}
        </TableCell>
      </TableRow>,
    )
    if (editorHere) {
      body.push(
        // Keyed by payee: another payee's editor starts afresh.
        <TableRow key={`category-editor-${payeeId(payee)}`} className="hover:bg-transparent">
          <TableCell colSpan={3} className="whitespace-normal">
            <CategoryEditor
              accountUid={accountUid}
              payee={payee}
              current={category}
              yours={rule !== undefined}
              count={countFrom(allTransactions, payee)}
              onDone={() => setEditing(null)}
            />
          </TableCell>
        </TableRow>,
      )
    }
  })

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{body}</TableBody>
    </Table>
  )
}

// Picks the category for everything from one payee, or goes back to the automatic one.
function CategoryEditor({
  accountUid,
  payee,
  current,
  yours,
  count,
  onDone,
}: {
  accountUid: string
  payee: Payee
  current: CategoryId
  yours: boolean
  count: number
  onDone: () => void
}) {
  const setRule = useSetCategoryRule(accountUid)
  const deleteRule = useDeleteCategoryRule(accountUid)
  const [category, setCategory] = useState<CategoryId>(current)
  const options = (Object.keys(CATEGORIES) as CategoryId[]).filter(
    (id) => CATEGORIES[id].direction === payee.direction,
  )
  const pending = setRule.isPending || deleteRule.isPending
  // Each action clears the other's error, so only the latest attempt's error shows.
  const error = setRule.error ?? deleteRule.error

  function submit(event: FormEvent) {
    event.preventDefault()
    deleteRule.reset()
    setRule.mutate({ direction: payee.direction, payee: payee.key, category }, { onSuccess: onDone })
  }

  function resetToAutomatic() {
    setRule.reset()
    deleteRule.mutate({ direction: payee.direction, payee: payee.key }, { onSuccess: onDone })
  }

  const which = count === 1 ? 'this transaction' : `all ${count} transactions`

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5 rounded-md border px-2 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Category for ${payee.label}`}
          className={COMPACT_FIELD_CLASS}
          value={category}
          onChange={(event) => setCategory(event.target.value as CategoryId)}
          autoFocus
        >
          {options.map((id) => (
            <option key={id} value={id}>
              {CATEGORIES[id].label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-1">
          <Button type="submit" size="sm" disabled={pending}>
            Save
          </Button>
          {yours && (
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={resetToAutomatic}>
              Use automatic
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {payee.source === 'name' ? (
          <>
            Applies to {which} from <span className="font-medium text-foreground">{payee.label}</span>, and future
            ones.
          </>
        ) : (
          <>
            Applies to {which} with a message like{' '}
            <span className="font-medium text-foreground">{payee.label}</span> (numbers and punctuation ignored), and
            future ones like it.
          </>
        )}
      </p>
      {error && <p className="text-xs text-destructive">{error.message}</p>}
    </form>
  )
}
