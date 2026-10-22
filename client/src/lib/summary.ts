import type { Transaction, TransactionsResponse } from '@/lib/api'

export interface MonthSummary {
  month: string // YYYY-MM
  moneyIn: number
  moneyOut: number
  net: number
}

export interface Summary {
  months: MonthSummary[]
  totalIn: number
  totalOut: number
  net: number
  currency: string | null
  // Booked transactions in the window left out because they were in a different currency.
  skipped: number
}

// Money in or out. Uses credit_debit_indicator, falling back to the amount's sign for banks
// that send signed amounts instead.
export function directionOf(transaction: Transaction): 'in' | 'out' | null {
  if (transaction.credit_debit_indicator === 'CRDT') return 'in'
  if (transaction.credit_debit_indicator === 'DBIT') return 'out'
  const amount = Number(transaction.transaction_amount.amount)
  if (amount > 0) return 'in'
  if (amount < 0) return 'out'
  return null
}

// Whole cents, so totals don't pick up floating-point error (e.g. a "−€0.00" net).
function toCents(amount: string): number {
  return Math.round(Math.abs(Number(amount)) * 100)
}

// Every YYYY-MM from `from` to `to` inclusive. Plain string arithmetic, so no timezone can shift it.
function monthsBetween(from: string, to: string): string[] {
  const keys: string[] = []
  let [year, month] = from.slice(0, 7).split('-').map(Number) as [number, number]
  const end = to.slice(0, 7)
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`
    if (key > end) break
    keys.push(key)
    month++
    if (month > 12) {
      month = 1
      year++
    }
  }
  return keys
}

function mostCommonCurrency(transactions: Transaction[]): string | null {
  const counts = new Map<string, number>()
  for (const transaction of transactions) {
    const currency = transaction.transaction_amount.currency
    counts.set(currency, (counts.get(currency) ?? 0) + 1)
  }
  let best: string | null = null
  for (const [currency, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = currency
  }
  return best
}

export function summarizeByMonth({ transactions, dateFrom, dateTo }: TransactionsResponse): Summary {
  // Only settled transactions inside the fetched window count. Pending ones are left out so an
  // amount that is pending and later booked isn't counted twice.
  const relevant = transactions.filter((transaction) => {
    const date = transaction.booking_date ?? transaction.value_date
    return date != null && date >= dateFrom && date <= dateTo && transaction.status !== 'PDNG'
  })

  const currency = mostCommonCurrency(relevant)
  const byMonth = new Map(
    monthsBetween(dateFrom, dateTo).map((month) => [month, { month, inCents: 0, outCents: 0 }]),
  )
  let skipped = 0

  for (const transaction of relevant) {
    if (transaction.transaction_amount.currency !== currency) {
      skipped++
      continue
    }
    const entry = byMonth.get((transaction.booking_date ?? transaction.value_date ?? '').slice(0, 7))
    const cents = toCents(transaction.transaction_amount.amount)
    if (!entry || Number.isNaN(cents)) continue

    const direction = directionOf(transaction)
    if (direction === 'in') entry.inCents += cents
    else if (direction === 'out') entry.outCents += cents
  }

  const months = [...byMonth.values()].map(({ month, inCents, outCents }) => ({
    month,
    moneyIn: inCents / 100,
    moneyOut: outCents / 100,
    net: (inCents - outCents) / 100,
  }))
  const totalInCents = [...byMonth.values()].reduce((sum, entry) => sum + entry.inCents, 0)
  const totalOutCents = [...byMonth.values()].reduce((sum, entry) => sum + entry.outCents, 0)

  return {
    months,
    totalIn: totalInCents / 100,
    totalOut: totalOutCents / 100,
    net: (totalInCents - totalOutCents) / 100,
    currency,
    skipped,
  }
}
