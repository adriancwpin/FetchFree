import { useMemo, useState, type FormEvent } from 'react'
import { Pencil, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useBudgets, useDeleteBudget, useSetBudget, useTransactions } from '@/hooks/useBank'
import { budgetProgress, monthOf, monthPace, type BudgetRow, type BudgetStatus } from '@/lib/budgets'
import { CATEGORIES, type CategoryId, type CategorySelection } from '@/lib/categories'
import { formatAmount, monthLabel } from '@/lib/format'
import { countedTransactions } from '@/lib/summary'
import { cn, COMPACT_FIELD_CLASS } from '@/lib/utils'

const SPENDING_CATEGORIES = (Object.keys(CATEGORIES) as CategoryId[]).filter(
  (category) => CATEGORIES[category].direction === 'out',
)

// Said in words as well as colour, so the status doesn't depend on seeing colour.
const STATUS: Record<BudgetStatus, { label: string; className: string }> = {
  onTrack: { label: 'On track', className: 'text-muted-foreground' },
  ahead: { label: 'Spending fast', className: 'text-amber-700 dark:text-amber-400' },
  over: { label: 'Over budget', className: 'text-destructive' },
}

// Monthly limits per spending category, for the month picked in the breakdown (or this month).
// Clicking a budget filters the transactions table to that category and month, like the breakdown.
export function Budgets({
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
  const budgets = useBudgets(accountUid)
  const setBudget = useSetBudget(accountUid)
  const deleteBudget = useDeleteBudget(accountUid)
  // A category id while editing that budget, 'new' while adding one.
  const [editing, setEditing] = useState<CategoryId | 'new' | null>(null)

  const [today] = useState(() => new Date())
  const month = selection.month ?? monthOf(today)
  const counted = useMemo(
    () => (transactions.data ? countedTransactions(transactions.data, accountCurrency) : null),
    [transactions.data, accountCurrency],
  )
  const rows = useMemo(
    () => (counted && budgets.data ? budgetProgress(counted, budgets.data, month, today) : []),
    [counted, budgets.data, month, today],
  )

  // Loading, errors and "no transactions" are shown by the table below.
  if (!counted?.currency || counted.transactions.length === 0) return null
  const { currency } = counted
  const pace = monthPace(month, today)
  const unbudgeted = SPENDING_CATEGORIES.filter((category) => !rows.some((row) => row.category === category))

  function save(category: CategoryId, amount: number) {
    setBudget.mutate({ category, amount }, { onSuccess: () => setEditing(null) })
  }

  function startEditing(next: CategoryId | 'new' | null) {
    setBudget.reset()
    setEditing(next)
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`budgets-${accountUid}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`budgets-${accountUid}`} className="text-sm font-medium">
          Budgets · {monthLabel(month, 'long')}
          {pace > 0 && pace < 1 && <span className="font-normal text-muted-foreground"> (so far)</span>}
        </h3>
        {editing !== 'new' && unbudgeted.length > 0 && budgets.data && (
          <Button variant="ghost" size="xs" onClick={() => startEditing('new')}>
            <Plus aria-hidden="true" />
            Add budget
          </Button>
        )}
      </div>

      {budgets.isError && <p className="text-sm text-destructive">{budgets.error.message}</p>}

      {editing === 'new' && (
        <BudgetForm
          categories={unbudgeted}
          currency={currency}
          pending={setBudget.isPending}
          error={setBudget.error}
          onSave={save}
          onCancel={() => startEditing(null)}
        />
      )}

      {budgets.data && rows.length === 0 && editing !== 'new' && (
        <p className="text-sm text-muted-foreground">
          No budgets yet. Set a monthly limit for a category to see how you're doing.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-1">
          {rows.map((row) =>
            editing === row.category ? (
              <li key={row.category}>
                <BudgetForm
                  categories={[row.category]}
                  initialAmount={row.limit}
                  currency={currency}
                  pending={setBudget.isPending}
                  error={setBudget.error}
                  onSave={save}
                  onCancel={() => startEditing(null)}
                />
              </li>
            ) : (
              <BudgetItem
                key={row.category}
                row={row}
                pace={pace}
                currency={currency}
                selected={selection.direction === 'out' && selection.category === row.category && selection.month === month}
                onSelect={(selected) =>
                  onSelectionChange({ direction: 'out', month, category: selected ? row.category : undefined })
                }
                onEdit={() => startEditing(row.category)}
                onRemove={() => deleteBudget.mutate(row.category)}
                removing={deleteBudget.isPending && deleteBudget.variables === row.category}
              />
            ),
          )}
        </ul>
      )}

      {deleteBudget.isError && <p className="text-sm text-destructive">{deleteBudget.error.message}</p>}
    </section>
  )
}

function BudgetItem({
  row,
  pace,
  currency,
  selected,
  onSelect,
  onEdit,
  onRemove,
  removing,
}: {
  row: BudgetRow
  pace: number
  currency: string
  selected: boolean
  onSelect: (selected: boolean) => void
  onEdit: () => void
  onRemove: () => void
  removing: boolean
}) {
  const { label, icon: Icon } = CATEGORIES[row.category]
  const status = STATUS[row.status]
  const money = (amount: number) => formatAmount(String(amount), currency)

  return (
    <li className="flex items-start gap-1">
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(!selected)}
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
          selected && 'bg-muted ring-1 ring-ring',
        )}
      >
        <span className="flex w-full items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="tabular-nums">
            <span className="font-medium">{money(row.spent)}</span>
            <span className="text-muted-foreground"> of {money(row.limit)}</span>
          </span>
        </span>
        {/* Spent against the limit; the tick marks how far through the month we are. */}
        <span
          className="relative h-1.5 w-full rounded-full bg-muted"
          role="progressbar"
          aria-label={`${label}: ${money(row.spent)} of ${money(row.limit)} spent`}
          aria-valuemin={0}
          aria-valuemax={row.limit}
          aria-valuenow={row.spent}
        >
          <span
            className={cn('block h-full rounded-full', row.status === 'over' ? 'bg-destructive' : 'bg-series-out')}
            style={{ width: `${Math.min(row.share, 1) * 100}%` }}
          />
          {pace > 0 && pace < 1 && (
            <span
              className="absolute -top-0.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/60"
              style={{ left: `${pace * 100}%` }}
              aria-hidden="true"
            />
          )}
        </span>
        <span className="flex w-full justify-between gap-2 text-xs">
          <span className={status.className}>{status.label}</span>
          <span className="text-muted-foreground tabular-nums">
            {row.remaining >= 0 ? `${money(row.remaining)} left` : `${money(-row.remaining)} over`}
          </span>
        </span>
      </button>
      <Button variant="ghost" size="icon-xs" className="mt-1.5" onClick={onEdit} aria-label={`Edit the ${label} budget`}>
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="mt-1.5"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove the ${label} budget`}
      >
        <X />
      </Button>
    </li>
  )
}

// Adding (pick a category) or editing (category fixed) a monthly limit.
function BudgetForm({
  categories,
  initialAmount,
  currency,
  pending,
  error,
  onSave,
  onCancel,
}: {
  categories: CategoryId[]
  initialAmount?: number
  currency: string
  pending: boolean
  error: Error | null
  onSave: (category: CategoryId, amount: number) => void
  onCancel: () => void
}) {
  const [category, setCategory] = useState<CategoryId>(categories[0]!)
  const [amount, setAmount] = useState(initialAmount === undefined ? '' : String(initialAmount))

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = Number(amount)
    if (value > 0) onSave(category, value)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5 rounded-md border px-2 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {categories.length === 1 ? (
          <span className="text-sm">{CATEGORIES[category].label}</span>
        ) : (
          <select
            aria-label="Category"
            className={COMPACT_FIELD_CLASS}
            value={category}
            onChange={(event) => setCategory(event.target.value as CategoryId)}
          >
            {categories.map((value) => (
              <option key={value} value={value}>
                {CATEGORIES[value].label}
              </option>
            ))}
          </select>
        )}
        <input
          type="number"
          inputMode="decimal"
          min="0.01"
          step="0.01"
          required
          autoFocus
          aria-label={`Monthly limit in ${currency}`}
          placeholder={`Limit (${currency})`}
          className={cn(COMPACT_FIELD_CLASS, 'w-32')}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">a month</span>
        <div className="ml-auto flex gap-1">
          <Button type="submit" size="sm" disabled={pending}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error.message}</p>}
    </form>
  )
}
