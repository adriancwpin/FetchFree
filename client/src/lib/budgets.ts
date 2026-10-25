import type { Budget } from '@/lib/api'
import { breakdownByCategory, CATEGORIES, type CategoryId, type CategoryRules } from '@/lib/categories'
import type { CountedTransactions } from '@/lib/summary'

// Spending faster than the month is passing, by more than this share of the limit, counts as "ahead".
const AHEAD_MARGIN = 0.1

export type BudgetStatus = 'onTrack' | 'ahead' | 'over'

export interface BudgetRow {
  category: CategoryId
  limit: number
  spent: number
  // Negative when over budget.
  remaining: number
  // spent ÷ limit (1 = the whole budget used).
  share: number
  status: BudgetStatus
}

// "2026-10" for the month `date` falls in, in the user's own timezone.
export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

// How much of `month` has gone by on `today`: 1 for a past month, 0 for a future one, and for the
// current month the share of its days so far, counting today (10 Oct → 10/31).
export function monthPace(month: string, today: Date): number {
  const [year = 0, monthNumber = 1] = month.split('-').map(Number)
  const current = monthOf(today)
  if (month < current) return 1
  if (month > current) return 0
  const daysInMonth = new Date(year, monthNumber, 0).getDate()
  return today.getDate() / daysInMonth
}

function isSpendingCategory(category: string): category is CategoryId {
  return Object.hasOwn(CATEGORIES, category) && CATEGORIES[category as CategoryId].direction === 'out'
}

// Each budget's spending for `month`, with what's left and how it's going. Spent comes from the
// category breakdown, so a budget always shows the same amount as its row there. Budgets for
// categories the app doesn't know (or income ones) are skipped. Over budget first, then fullest.
export function budgetProgress(
  counted: CountedTransactions,
  budgets: Budget[],
  month: string,
  today: Date,
  rules?: CategoryRules,
): BudgetRow[] {
  const spentCents = new Map(
    breakdownByCategory(counted, 'out', month, rules).map((row) => [row.category, Math.round(row.amount * 100)]),
  )
  const pace = monthPace(month, today)

  return budgets
    .filter((budget): budget is Budget & { category: CategoryId } => isSpendingCategory(budget.category))
    .map((budget) => {
      const limitCents = Math.round(budget.amount * 100)
      const spent = spentCents.get(budget.category) ?? 0
      const share = limitCents === 0 ? 0 : spent / limitCents
      const status: BudgetStatus = spent > limitCents ? 'over' : share > pace + AHEAD_MARGIN ? 'ahead' : 'onTrack'
      return {
        category: budget.category,
        limit: limitCents / 100,
        spent: spent / 100,
        remaining: (limitCents - spent) / 100,
        share,
        status,
      }
    })
    .sort(
      (a, b) =>
        Number(b.status === 'over') - Number(a.status === 'over') ||
        b.share - a.share ||
        CATEGORIES[a.category].label.localeCompare(CATEGORIES[b.category].label),
    )
}
