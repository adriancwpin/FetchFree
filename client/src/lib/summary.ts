import type { Transaction } from '@/lib/api'

// Must match HISTORY_MONTHS in server/src/routes/accounts.ts.
export const SUMMARY_MONTHS = 6

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
  // Transactions left out because they were in a different currency.
  skipped: number
}

function lastMonths(count: number, now: Date): string[] {
  const keys: string[] = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1)
    keys.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`)
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

export function summarizeByMonth(
  transactions: Transaction[],
  months = SUMMARY_MONTHS,
  now = new Date(),
): Summary {
  const currency = mostCommonCurrency(transactions)
  const byMonth = new Map(
    lastMonths(months, now).map((month) => [month, { month, moneyIn: 0, moneyOut: 0, net: 0 }]),
  )
  let skipped = 0

  for (const transaction of transactions) {
    if (transaction.transaction_amount.currency !== currency) {
      skipped++
      continue
    }
    const entry = byMonth.get((transaction.booking_date ?? transaction.value_date ?? '').slice(0, 7))
    const amount = Math.abs(Number(transaction.transaction_amount.amount))
    if (!entry || Number.isNaN(amount)) continue

    if (transaction.credit_debit_indicator === 'CRDT') entry.moneyIn += amount
    else if (transaction.credit_debit_indicator === 'DBIT') entry.moneyOut += amount
  }

  const result = [...byMonth.values()].map((entry) => ({
    ...entry,
    net: entry.moneyIn - entry.moneyOut,
  }))
  const totalIn = result.reduce((sum, entry) => sum + entry.moneyIn, 0)
  const totalOut = result.reduce((sum, entry) => sum + entry.moneyOut, 0)

  return { months: result, totalIn, totalOut, net: totalIn - totalOut, currency, skipped }
}
