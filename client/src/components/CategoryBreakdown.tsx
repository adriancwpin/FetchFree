import { useEffect, useMemo } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useCategoryRules, useTransactions } from '@/hooks/useBank'
import { breakdownByCategory, CATEGORIES, type CategorySelection, type Direction } from '@/lib/categories'
import { formatAmount, monthLabel } from '@/lib/format'
import { countedTransactions } from '@/lib/summary'
import { cn, COMPACT_FIELD_CLASS } from '@/lib/utils'

// One colour per direction, the same as the monthly chart: this is one series ranked by size,
// so categories are told apart by their label and icon, never by colour.
const BAR_CLASS: Record<Direction, string> = { out: 'bg-series-out', in: 'bg-series-in' }

// Controlled by the account card, which also filters the transactions table with the same
// selection, so the controls, the highlighted row and the table can never disagree.
export function CategoryBreakdown({
  accountUid,
  accountCurrency,
  selection,
  onSelectionChange,
}: {
  accountUid: string
  accountCurrency: string | null
  selection: CategorySelection
  onSelectionChange: (selection: CategorySelection) => void
}) {
  const transactions = useTransactions(accountUid)
  const rules = useCategoryRules(accountUid)
  const counted = useMemo(
    () => (transactions.data ? countedTransactions(transactions.data, accountCurrency) : null),
    [transactions.data, accountCurrency],
  )
  const rows = useMemo(
    () => (counted ? breakdownByCategory(counted, selection.direction, selection.month, rules.data) : []),
    [counted, selection.direction, selection.month, rules.data],
  )

  // If the selected category no longer has any transactions (e.g. after a refetch, or because
  // nothing is counted any more), drop it so the table isn't left filtered to nothing.
  // Only once data has loaded, so a filter isn't dropped while the transactions or the user's own
  // categories are still loading.
  const selectedMissing =
    counted !== null &&
    !rules.isPending &&
    selection.category !== undefined &&
    !rows.some((row) => row.category === selection.category)
  useEffect(() => {
    if (selectedMissing) onSelectionChange({ ...selection, category: undefined })
  }, [selectedMissing, selection, onSelectionChange])

  // Loading, errors and "no transactions" are shown by the table below. Waits for the user's own
  // categories, which decide each category's total.
  if (!counted?.currency || counted.transactions.length === 0) return null
  if (rules.isPending) return <Skeleton className="h-24 w-full" />
  const { currency } = counted

  const largest = rows[0]?.amount ?? 0
  const periodLabel = selection.month ? monthLabel(selection.month, 'long') : 'this period'

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`breakdown-${accountUid}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`breakdown-${accountUid}`} className="text-sm font-medium">
          {selection.direction === 'out' ? 'Where your money went' : 'Where your money came from'}
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-0.5" role="group" aria-label="Spending or income">
            {(['out', 'in'] as const).map((value) => (
              <Button
                key={value}
                size="xs"
                variant={selection.direction === value ? 'secondary' : 'ghost'}
                aria-pressed={selection.direction === value}
                onClick={() => onSelectionChange({ direction: value, month: selection.month })}
              >
                {value === 'out' ? 'Spending' : 'Income'}
              </Button>
            ))}
          </div>
          <select
            aria-label="Period"
            className={COMPACT_FIELD_CLASS}
            value={selection.month ?? ''}
            onChange={(event) =>
              onSelectionChange({ direction: selection.direction, month: event.target.value || undefined })
            }
          >
            <option value="">All months</option>
            {[...counted.months].reverse().map((value) => (
              <option key={value} value={value}>
                {monthLabel(value, 'long')}
              </option>
            ))}
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {selection.direction === 'out' ? 'spending' : 'income'} in {periodLabel}.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => {
            const { label, icon: Icon } = CATEGORIES[row.category]
            const selected = selection.category === row.category
            return (
              <li key={row.category}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectionChange({ ...selection, category: selected ? undefined : row.category })}
                  className={cn(
                    'flex w-full flex-col gap-1.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                    selected && 'bg-muted ring-1 ring-ring',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {Math.round(row.share * 100)}%
                    </span>
                    <span className="w-24 text-right font-medium tabular-nums">
                      {formatAmount(String(row.amount), currency)}
                    </span>
                  </span>
                  {/* Bar length relative to the largest category; a muted track shows the rest. */}
                  <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span
                      className={cn('block h-full rounded-full', BAR_CLASS[selection.direction])}
                      style={{ width: `${largest === 0 ? 0 : (row.amount / largest) * 100}%` }}
                    />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {rows.length > 0 && rows.every((row) => row.category === 'otherOut' || row.category === 'otherIn') && (
        <p className="text-xs text-muted-foreground">
          Categories are worked out from each transaction's description, and these didn't match any. Click a
          transaction's category below to change it.
        </p>
      )}
    </section>
  )
}

// Shown above the table while it's filtered to one category.
export function CategoryFilterChip({ selection, onClear }: { selection: CategorySelection; onClear: () => void }) {
  if (!selection.category) return null
  const { label, icon: Icon } = CATEGORIES[selection.category]
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Showing:</span>
      <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        {label}
        {selection.month && <span className="text-muted-foreground">· {monthLabel(selection.month, 'long')}</span>}
        <button
          type="button"
          onClick={onClear}
          className="-mr-1 rounded-full p-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={`Show all transactions, not just ${label}`}
        >
          <X className="size-3.5" />
        </button>
      </span>
    </div>
  )
}
