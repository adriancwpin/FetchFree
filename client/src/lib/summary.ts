import type { Transaction, TransactionsResponse } from '@/lib/api'

export interface MonthSummary {
  month: string // YYYY-MM
  moneyIn: number
  moneyOut: number
  net: number
  // Set when the fetched window starts mid-month, e.g. "2026-07-25"; the bar covers only part of it.
  partialFrom: string | null
}

export interface Summary {
  months: MonthSummary[]
  totalIn: number
  totalOut: number
  net: number
  currency: string | null
  // Settled transactions in the window left out because they were in a different currency.
  skipped: number
  // In the window but not counted: not settled *yet* (pending, scheduled, on hold)…
  notYetSettled: number
  // …or never moved money (cancelled, rejected, informational, other).
  notCounted: number
}

const NOT_YET_SETTLED_STATUSES = new Set(['PDNG', 'SCHD', 'HOLD'])

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

// The date a transaction belongs to; shared by the summary and the table's ordering.
export function dateOf(transaction: Transaction): string | null {
  return transaction.booking_date ?? transaction.value_date ?? null
}

// Only booked transactions moved money. Pending, scheduled, cancelled, rejected, held and
// informational entries are left out; a missing status is treated as booked.
function isSettled(transaction: Transaction): boolean {
  return transaction.status == null || transaction.status === 'BOOK'
}

// Whole cents, so totals don't pick up floating-point error (e.g. a "−€0.00" net).
export function toCents(amount: string): number {
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

// YYYY-MM-DD plus `days`, in plain UTC date arithmetic.
function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

// The account's own currency when the bank reports it and transactions actually use it;
// otherwise the most common currency among the counted transactions (e.g. a wallet account
// whose transactions are listed in another currency).
function pickCurrency(settled: Transaction[], accountCurrency: string | null | undefined): string | null {
  if (accountCurrency && settled.some((t) => t.transaction_amount.currency === accountCurrency)) {
    return accountCurrency
  }
  return mostCommonCurrency(settled) ?? accountCurrency ?? null
}

export interface CountedTransactions {
  // Settled transactions inside the window, in `currency`, with a usable amount: the set that
  // every total (monthly chart, category breakdown) is built from.
  transactions: Transaction[]
  currency: string | null
  // Every YYYY-MM the window covers, in order.
  months: string[]
  skipped: number
  notYetSettled: number
  notCounted: number
}

// Decides which transactions count towards totals. Shared by the monthly summary and the category
// breakdown so their totals always agree.
export function countedTransactions(
  { transactions, dateFrom, dateTo }: TransactionsResponse,
  accountCurrency?: string | null,
): CountedTransactions {
  // dateTo is the server's UTC date. Allow one extra day for users ahead of UTC (whose "today"
  // is already tomorrow there), but no further: a future-dated or bogus date (e.g. 9999-12-31)
  // must not stretch the chart with empty months.
  const windowEnd = addDays(dateTo, 1)
  const inWindow = transactions.filter((transaction) => {
    const date = dateOf(transaction)
    return date != null && date >= dateFrom && date <= windowEnd
  })
  const settled = inWindow.filter(isSettled)
  const notYetSettled = inWindow.filter((t) => t.status != null && NOT_YET_SETTLED_STATUSES.has(t.status)).length

  const currency = pickCurrency(settled, accountCurrency)
  const counted = settled.filter(
    (t) => t.transaction_amount.currency === currency && !Number.isNaN(toCents(t.transaction_amount.amount)),
  )
  // Add the next month only if a transaction is actually dated in it.
  const lastDate = settled.some((t) => (dateOf(t) ?? '') > dateTo) ? windowEnd : dateTo

  return {
    transactions: counted,
    currency,
    months: monthsBetween(dateFrom, lastDate),
    skipped: settled.filter((t) => t.transaction_amount.currency !== currency).length,
    notYetSettled,
    notCounted: inWindow.length - settled.length - notYetSettled,
  }
}

export function summarizeByMonth(response: TransactionsResponse, accountCurrency?: string | null): Summary {
  const { dateFrom } = response
  const counted = countedTransactions(response, accountCurrency)
  const byMonth = new Map(counted.months.map((month) => [month, { month, inCents: 0, outCents: 0 }]))

  let totalInCents = 0
  let totalOutCents = 0
  for (const transaction of counted.transactions) {
    const entry = byMonth.get((dateOf(transaction) ?? '').slice(0, 7))
    if (!entry) continue
    const cents = toCents(transaction.transaction_amount.amount)

    const direction = directionOf(transaction)
    if (direction === 'in') {
      entry.inCents += cents
      totalInCents += cents
    } else if (direction === 'out') {
      entry.outCents += cents
      totalOutCents += cents
    }
  }

  const startsMidMonth = !dateFrom.endsWith('-01')
  const months = [...byMonth.values()].map(({ month, inCents, outCents }, index) => ({
    month,
    moneyIn: inCents / 100,
    moneyOut: outCents / 100,
    net: (inCents - outCents) / 100,
    partialFrom: index === 0 && startsMidMonth ? dateFrom : null,
  }))

  return {
    months,
    totalIn: totalInCents / 100,
    totalOut: totalOutCents / 100,
    net: (totalInCents - totalOutCents) / 100,
    currency: counted.currency,
    skipped: counted.skipped,
    notYetSettled: counted.notYetSettled,
    notCounted: counted.notCounted,
  }
}
