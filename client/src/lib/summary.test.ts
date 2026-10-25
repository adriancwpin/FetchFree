import { describe, expect, it } from 'vitest'
import type { Transaction, TransactionsResponse } from '@/lib/api'
import { dateOf, directionOf, summarizeByMonth } from '@/lib/summary'

function tx(
  date: string | null,
  amount: string,
  indicator: 'CRDT' | 'DBIT' | null,
  extra: Partial<Transaction> = {},
): Transaction {
  return {
    booking_date: date,
    transaction_amount: { amount, currency: extra.transaction_amount?.currency ?? 'EUR' },
    credit_debit_indicator: indicator,
    ...extra,
  } as Transaction
}

function usd(date: string, amount: string, indicator: 'CRDT' | 'DBIT'): Transaction {
  return tx(date, amount, indicator, { transaction_amount: { amount, currency: 'USD' } })
}

function summarize(
  transactions: Transaction[],
  window: Partial<Pick<TransactionsResponse, 'dateFrom' | 'dateTo'>> = {},
  accountCurrency?: string | null,
) {
  return summarizeByMonth(
    { transactions, dateFrom: '2026-05-01', dateTo: '2026-10-22', truncated: false, lastSyncedAt: '2026-10-22T12:00:00.000Z', syncError: null, gap: null, ...window },
    accountCurrency,
  )
}

describe('directionOf', () => {
  it('uses the credit/debit indicator', () => {
    expect(directionOf(tx('2026-10-01', '5', 'CRDT'))).toBe('in')
    expect(directionOf(tx('2026-10-01', '5', 'DBIT'))).toBe('out')
  })

  it("falls back to the amount's sign when there is no indicator", () => {
    expect(directionOf(tx('2026-10-01', '100', null))).toBe('in')
    expect(directionOf(tx('2026-10-01', '-40', null))).toBe('out')
    expect(directionOf(tx('2026-10-01', '0', null))).toBeNull()
  })
})

describe('dateOf', () => {
  it('prefers the booking date, then the value date', () => {
    expect(dateOf(tx('2026-10-01', '1', 'DBIT', { value_date: '2026-10-03' }))).toBe('2026-10-01')
    expect(dateOf(tx(null, '1', 'DBIT', { value_date: '2026-10-03' }))).toBe('2026-10-03')
    expect(dateOf(tx(null, '1', 'DBIT'))).toBeNull()
  })
})

describe('summarizeByMonth', () => {
  it('adds money in and out per month, with empty months filled in', () => {
    const summary = summarize([
      tx('2026-10-03', '1000.00', 'CRDT'),
      tx('2026-10-10', '250.50', 'DBIT'),
      tx('2026-08-15', '40', 'DBIT'),
    ])

    expect(summary.months.map((month) => month.month)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ])
    expect(summary.months.find((month) => month.month === '2026-08')).toMatchObject({ moneyIn: 0, moneyOut: 40 })
    expect(summary).toMatchObject({ totalIn: 1000, totalOut: 290.5, net: 709.5, currency: 'EUR' })
  })

  it('sums in whole cents, so 0.1 + 0.2 in and 0.3 out nets to exactly zero', () => {
    const summary = summarize([
      tx('2026-10-01', '0.1', 'CRDT'),
      tx('2026-10-01', '0.2', 'CRDT'),
      tx('2026-10-01', '0.3', 'DBIT'),
    ])

    expect(summary.net).toBe(0)
    expect(summary.totalIn).toBe(0.3)
  })

  it('gives exact totals for amounts that floats get wrong (19.99 × 100 is 1998.999…)', () => {
    const summary = summarize([
      tx('2026-10-01', '19.99', 'DBIT'),
      tx('2026-10-02', '19.99', 'DBIT'),
      tx('2026-10-03', '19.99', 'DBIT'),
    ])

    expect(summary.totalOut).toBe(59.97)
    expect(summary.months.at(-1)?.moneyOut).toBe(59.97)
  })

  it('counts signed amounts without an indicator', () => {
    const summary = summarize([tx('2026-10-01', '-40.00', null), tx('2026-10-02', '100.00', null)])
    expect(summary).toMatchObject({ totalIn: 100, totalOut: 40 })
  })

  describe('date window', () => {
    it('ignores transactions before the window and those with no date', () => {
      const summary = summarize([tx('2026-04-30', '999', 'DBIT'), tx(null, '5', 'DBIT'), tx('2026-05-01', '1', 'DBIT')])
      expect(summary.totalOut).toBe(1)
    })

    it('still counts a transaction dated "tomorrow" (a user ahead of UTC)', () => {
      expect(summarize([tx('2026-10-23', '7', 'DBIT')]).totalOut).toBe(7)
    })

    it('adds the next month only when such a transaction actually falls in it', () => {
      const summary = summarize([tx('2026-11-01', '7', 'DBIT')], { dateTo: '2026-10-31' })
      expect(summary.months.at(-1)).toMatchObject({ month: '2026-11', moneyOut: 7 })
      expect(summarize([], { dateTo: '2026-10-31' }).months.at(-1)?.month).toBe('2026-10')
    })

    it('ignores future-dated and bogus dates instead of stretching the chart', () => {
      const summary = summarize([
        tx('2026-10-01', '5', 'DBIT'),
        tx('2027-03-15', '1', 'DBIT'),
        tx('9999-12-31', '1', 'DBIT'),
      ])
      expect(summary.months).toHaveLength(6)
      expect(summary.totalOut).toBe(5)
    })

    it('marks the first month as partial when the window starts mid-month', () => {
      const summary = summarize([], { dateFrom: '2026-07-25', dateTo: '2026-10-22' })
      expect(summary.months.map((month) => month.month)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10'])
      expect(summary.months[0]?.partialFrom).toBe('2026-07-25')
      expect(summary.months[1]?.partialFrom).toBeNull()
    })

    it('crosses a year boundary', () => {
      const summary = summarize([], { dateFrom: '2026-11-01', dateTo: '2027-02-10' })
      expect(summary.months.map((month) => month.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
    })
  })

  describe('transaction status', () => {
    it('counts only booked transactions and explains the rest', () => {
      const summary = summarize([
        tx('2026-10-01', '1', 'DBIT', { status: 'BOOK' }),
        tx('2026-10-01', '2', 'DBIT'), // no status: treated as booked
        ...['PDNG', 'SCHD', 'HOLD'].map((status) => tx('2026-10-01', '500', 'DBIT', { status })),
        ...['CNCL', 'RJCT', 'INFO'].map((status) => tx('2026-10-01', '500', 'DBIT', { status })),
      ])

      expect(summary.totalOut).toBe(3)
      expect(summary.notYetSettled).toBe(3)
      expect(summary.notCounted).toBe(3)
    })
  })

  describe('currency', () => {
    it("uses the account's currency and skips others", () => {
      const summary = summarize(
        [tx('2026-10-01', '100', 'CRDT'), usd('2026-10-02', '1', 'DBIT'), usd('2026-10-03', '1', 'DBIT')],
        {},
        'EUR',
      )
      expect(summary).toMatchObject({ currency: 'EUR', totalIn: 100, totalOut: 0, skipped: 2 })
    })

    it("uses the most common currency when the account's currency isn't used by any transaction", () => {
      const summary = summarize([usd('2026-10-01', '9', 'DBIT'), usd('2026-10-02', '3', 'CRDT')], {}, 'GBP')
      expect(summary).toMatchObject({ currency: 'USD', totalIn: 3, totalOut: 9, skipped: 0 })
    })

    it('only lets transactions inside the window decide the currency', () => {
      const summary = summarize([
        tx('2026-10-01', '10', 'DBIT'),
        usd('2024-01-01', '1', 'DBIT'),
        usd('2024-01-02', '1', 'DBIT'),
      ])
      expect(summary).toMatchObject({ currency: 'EUR', skipped: 0 })
    })
  })
})
