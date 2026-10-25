import { describe, expect, it } from 'vitest'
import type { Transaction, TransactionsResponse } from '@/lib/api'
import { budgetProgress, monthOf, monthPace } from '@/lib/budgets'
import { breakdownByCategory } from '@/lib/categories'
import { countedTransactions } from '@/lib/summary'

function spend(counterparty: string, amount: string, date: string): Transaction {
  return {
    booking_date: date,
    transaction_amount: { amount, currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    creditor: { name: counterparty },
    remittance_information: [],
  } as Transaction
}

function counted(transactions: Transaction[]) {
  const response: TransactionsResponse = {
    transactions,
    dateFrom: '2026-05-01',
    dateTo: '2026-10-25',
    truncated: false,
    lastSyncedAt: '2026-10-25T12:00:00.000Z',
    syncError: null,
    gap: null,
  }
  return countedTransactions(response, 'EUR')
}

// Local time, like the app's "today".
const OCT_10 = new Date(2026, 9, 10, 15, 0)

const sample = counted([
  spend('K market', '19.99', '2026-10-01'),
  spend('K market', '19.99', '2026-10-03'),
  spend('K market', '19.99', '2026-10-08'),
  spend('K market', '500.00', '2026-09-15'),
  spend('Internet Pizza Oy', '45.00', '2026-10-04'),
])

describe('monthPace', () => {
  it('is the share of the current month gone by, counting today', () => {
    expect(monthPace('2026-10', OCT_10)).toBeCloseTo(10 / 31, 10)
  })

  it('is 1 for a past month and 0 for a future one', () => {
    expect(monthPace('2026-09', OCT_10)).toBe(1)
    expect(monthPace('2026-11', OCT_10)).toBe(0)
  })

  it('handles short months', () => {
    expect(monthPace('2026-02', new Date(2026, 1, 14))).toBe(0.5)
  })
})

describe('monthOf', () => {
  it('pads the month', () => {
    expect(monthOf(new Date(2026, 0, 31))).toBe('2026-01')
  })
})

describe('budgetProgress', () => {
  it('spends exactly what the breakdown shows for the category and month, in cents', () => {
    const [groceries] = budgetProgress(sample, [{ category: 'groceries', amount: 100 }], '2026-10', OCT_10)
    const breakdownRow = breakdownByCategory(sample, 'out', '2026-10').find((row) => row.category === 'groceries')

    expect(groceries!.spent).toBe(59.97)
    expect(groceries!.spent).toBe(breakdownRow!.amount)
    expect(groceries!.remaining).toBe(40.03)
  })

  it('reports how far over a budget is', () => {
    const [groceries] = budgetProgress(sample, [{ category: 'groceries', amount: 400 }], '2026-09', OCT_10)
    expect(groceries).toMatchObject({ spent: 500, remaining: -100, share: 1.25, status: 'over' })
  })

  it('compares spending with how far through the month we are', () => {
    // 10 Oct: about 32% of the month gone. 59.97 of 150 is 40% (within the 10-point margin): on track.
    expect(budgetProgress(sample, [{ category: 'groceries', amount: 150 }], '2026-10', OCT_10)[0]!.status).toBe('onTrack')
    // 59.97 of 100 is 60%: spending fast.
    expect(budgetProgress(sample, [{ category: 'groceries', amount: 100 }], '2026-10', OCT_10)[0]!.status).toBe('ahead')
  })

  it('a past month under budget is on track, however close', () => {
    expect(budgetProgress(sample, [{ category: 'groceries', amount: 500 }], '2026-09', OCT_10)[0]!.status).toBe('onTrack')
  })

  it('shows nothing spent for a budget with no spending', () => {
    expect(budgetProgress(sample, [{ category: 'travel', amount: 200 }], '2026-10', OCT_10)[0]).toMatchObject({
      spent: 0,
      remaining: 200,
      share: 0,
      status: 'onTrack',
    })
  })

  it('skips budgets for unknown or income categories', () => {
    const rows = budgetProgress(
      sample,
      [
        { category: 'notACategory', amount: 10 },
        { category: 'salary', amount: 10 },
        { category: 'constructor', amount: 10 },
      ],
      '2026-10',
      OCT_10,
    )
    expect(rows).toEqual([])
  })

  it('lists over-budget first, then the fullest', () => {
    const rows = budgetProgress(
      sample,
      [
        { category: 'travel', amount: 100 },
        { category: 'groceries', amount: 200 },
        { category: 'eatingOut', amount: 40 },
      ],
      '2026-10',
      OCT_10,
    )
    expect(rows.map((row) => row.category)).toEqual(['eatingOut', 'groceries', 'travel'])
  })
})
