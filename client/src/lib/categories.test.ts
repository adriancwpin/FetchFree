import { describe, expect, it } from 'vitest'
import type { Transaction, TransactionsResponse } from '@/lib/api'
import { breakdownByCategory, CATEGORIES, categorize, type CategoryId, RULES, transactionsFor } from '@/lib/categories'
import { countedTransactions, summarizeByMonth } from '@/lib/summary'

interface Example {
  direction: 'in' | 'out'
  counterparty?: string
  message?: string
  bankCode?: string
  amount?: string
  date?: string
}

function tx({ direction, counterparty, message, bankCode, amount = '10.00', date = '2026-10-15' }: Example): Transaction {
  return {
    booking_date: date,
    transaction_amount: { amount, currency: 'EUR' },
    credit_debit_indicator: direction === 'out' ? 'DBIT' : 'CRDT',
    status: 'BOOK',
    creditor: direction === 'out' && counterparty ? { name: counterparty } : null,
    debtor: direction === 'in' && counterparty ? { name: counterparty } : null,
    remittance_information: message ? [message] : [],
    bank_transaction_code: bankCode ? { description: bankCode } : null,
  } as Transaction
}

describe('categorize', () => {
  // Real transactions from the Nordea (Finland) sandbox.
  it.each<[CategoryId, Example]>([
    ['groceries', { direction: 'out', counterparty: 'K market Helsinki', message: '18110005577890 Helsinki', bankCode: 'Korttiosto' }],
    ['groceries', { direction: 'out', counterparty: 'Wallmart', message: '678944335600 USD 9.39 Gotham City', bankCode: 'Korttiosto' }],
    ['cash', { direction: 'out', counterparty: 'ATM Nosto 1212', message: '550772345 EUR 35.00 Helsinki', bankCode: 'Debet automaattiotto' }],
    ['bills', { direction: 'out', counterparty: 'Salo Johanna', message: '447711118878060000 Mobile phone', bankCode: 'Itsepalvelu' }],
    ['entertainment', { direction: 'out', counterparty: 'Salo Johanna', message: '671232100994 Kino Kino', bankCode: 'Itsepalvelu' }],
    ['gifts', { direction: 'out', counterparty: 'Helsinkimissio ry', message: '181120258878060000', bankCode: 'Itsepalvelu' }],
    ['gifts', { direction: 'out', counterparty: 'Salo Ari', message: '221127000000 For present to Johanna', bankCode: 'Mibiilimaksu' }],
    ['health', { direction: 'out', counterparty: 'Cross  Sports Club', message: '660562087011 01012019', bankCode: 'e-maksu' }],
    ['travel', { direction: 'out', counterparty: 'Gebr Heinemann Retail', message: '181114280444 DKK 49,00 Kastrup', bankCode: 'Korttiosto' }],
    // Car hire at an airport is still transport, not travel.
    ['transport', { direction: 'out', counterparty: 'Avis', message: '795622333023 GBP 31.20 Heathrow', bankCode: 'Korttiosto' }],
    ['benefits', { direction: 'in', counterparty: 'KELA/FPA', message: 'LL4200K6790 Lapsilisä', bankCode: 'Pano' }],
    ['transfersIn', { direction: 'in', counterparty: 'Salo Ari', message: 'Lahjat', bankCode: 'Oma siirto' }],
    ['fromPeople', { direction: 'in', counterparty: 'Simon Baker', message: '111144419244 Kiitos', bankCode: 'Pano' }],
    ['otherIn', { direction: 'in', counterparty: 'SMM Appartments', message: '221127019888 Rent', bankCode: 'Pano' }],
  ])('puts a real Nordea transaction in %s', (expected, example) => {
    expect(categorize(tx(example))).toBe(expected)
  })

  it('ignores case and accents', () => {
    expect(categorize(tx({ direction: 'in', message: 'LAPSILISA' }))).toBe('benefits')
    expect(categorize(tx({ direction: 'out', message: 'Sähkölasku' }))).toBe('bills')
  })

  it('lets the first matching rule win: an own transfer mentioning rent is still a transfer', () => {
    expect(categorize(tx({ direction: 'out', message: 'Rent', bankCode: 'Oma siirto' }))).toBe('transfersOut')
  })

  it('matches whole words only, so "current" is not rent and "parent" is not rent', () => {
    expect(categorize(tx({ direction: 'out', message: 'current account fee' }))).not.toBe('housing')
    expect(categorize(tx({ direction: 'out', message: 'for parents' }))).not.toBe('housing')
  })

  it.each<[string, Example, CategoryId]>([
    ['a merchant name containing a bill word', { direction: 'out', counterparty: 'Internet Pizza Oy' }, 'eatingOut'],
    ['a word that only starts like a keyword', { direction: 'out', counterparty: 'Steamboat Tours', message: 'Hotel transfer' }, 'travel'],
    ['a taxi to the airport', { direction: 'out', counterparty: 'Taksi Helsinki', message: 'Helsinki-Vantaa airport' }, 'transport'],
  ])('puts %s in the right category', (_case, example, expected) => {
    expect(categorize(tx(example))).toBe(expected)
  })

  it('does not treat every Finnish association ("ry") as a charity', () => {
    expect(categorize(tx({ direction: 'out', counterparty: 'Helsingin Jalkapallo ry', message: 'Jäsenmaksu' }))).not.toBe('gifts')
  })

  it('lists every rule under the direction its category belongs to', () => {
    for (const [direction, rules] of Object.entries(RULES)) {
      for (const rule of rules) expect(CATEGORIES[rule.category].direction).toBe(direction)
    }
  })

  it('uses only money-in rules for money in: a refund from a supermarket is not "groceries"', () => {
    expect(categorize(tx({ direction: 'in', counterparty: 'K market Helsinki' }))).toBe('otherIn')
  })

  describe('fallbacks', () => {
    it('treats an unmatched card purchase as shopping', () => {
      expect(categorize(tx({ direction: 'out', counterparty: 'Unknown Shop Oy', bankCode: 'Korttiosto' }))).toBe('shopping')
    })

    it("treats a payment to a person's name as a payment to people", () => {
      expect(categorize(tx({ direction: 'out', counterparty: 'Salo Johanna', message: '12345' }))).toBe('toPeople')
    })

    it('does not mistake a business for a person', () => {
      expect(categorize(tx({ direction: 'out', counterparty: 'Acme Services', message: '12345' }))).toBe('otherOut')
    })

    it('falls back to Other when nothing matches', () => {
      expect(categorize(tx({ direction: 'out', message: '9999 xyz' }))).toBe('otherOut')
    })
  })
})

describe('breakdownByCategory', () => {
  const response = (transactions: Transaction[]): TransactionsResponse => ({
    transactions,
    dateFrom: '2026-05-01',
    dateTo: '2026-10-22',
    truncated: false,
    lastSyncedAt: '2026-10-22T12:00:00.000Z',
    syncError: null,
    gap: null,
  })

  const sample = response([
    tx({ direction: 'out', counterparty: 'K market', amount: '19.99', date: '2026-10-01' }),
    tx({ direction: 'out', counterparty: 'K market', amount: '19.99', date: '2026-10-02' }),
    tx({ direction: 'out', counterparty: 'ATM 1', bankCode: 'Debet automaattiotto', amount: '50.00', date: '2026-09-10' }),
    tx({ direction: 'out', message: 'Mobile phone', amount: '15.00', date: '2026-10-05' }),
    tx({ direction: 'in', counterparty: 'KELA/FPA', amount: '100.00', date: '2026-10-03' }),
  ])

  it('totals each category in cents, largest first', () => {
    const rows = breakdownByCategory(countedTransactions(sample), 'out')

    expect(rows.map((row) => [row.category, row.amount, row.count])).toEqual([
      ['cash', 50, 1],
      ['groceries', 39.98, 2],
      ['bills', 15, 1],
    ])
  })

  it('adds up to exactly the summary\'s "Money out" and "Money in"', () => {
    const counted = countedTransactions(sample)
    const summary = summarizeByMonth(sample)
    const sum = (rows: { amount: number }[]) => Math.round(rows.reduce((total, row) => total + row.amount * 100, 0)) / 100

    expect(sum(breakdownByCategory(counted, 'out'))).toBe(summary.totalOut)
    expect(sum(breakdownByCategory(counted, 'in'))).toBe(summary.totalIn)
  })

  it('gives shares that add up to 100%', () => {
    const rows = breakdownByCategory(countedTransactions(sample), 'out')
    expect(rows.reduce((total, row) => total + row.share, 0)).toBeCloseTo(1, 10)
  })

  it('can be limited to one month', () => {
    const rows = breakdownByCategory(countedTransactions(sample), 'out', '2026-09')
    expect(rows).toEqual([{ category: 'cash', amount: 50, count: 1, share: 1 }])
  })

  it('leaves out what the summary leaves out (pending, other currencies)', () => {
    const rows = breakdownByCategory(
      countedTransactions(
        response([
          tx({ direction: 'out', counterparty: 'K market', amount: '10.00' }),
          { ...tx({ direction: 'out', counterparty: 'K market', amount: '99.00' }), status: 'PDNG' },
          { ...tx({ direction: 'out', counterparty: 'K market' }), transaction_amount: { amount: '5', currency: 'USD' } },
        ]),
        'EUR',
      ),
      'out',
    )
    expect(rows).toEqual([{ category: 'groceries', amount: 10, count: 1, share: 1 }])
  })

  it('returns nothing for a direction with no transactions', () => {
    expect(breakdownByCategory(countedTransactions(response([])), 'out')).toEqual([])
  })
})

describe('transactionsFor (what the filtered table shows)', () => {
  const response = (transactions: Transaction[]): TransactionsResponse => ({
    transactions,
    dateFrom: '2026-05-01',
    dateTo: '2026-10-22',
    truncated: false,
    lastSyncedAt: '2026-10-22T12:00:00.000Z',
    syncError: null,
    gap: null,
  })

  it('lists exactly what the breakdown counted for a category, so the rows add up to its amount', () => {
    const counted = countedTransactions(
      response([
        tx({ direction: 'out', counterparty: 'K market', amount: '19.99' }),
        tx({ direction: 'out', counterparty: 'K market', amount: '19.99' }),
        // Not counted by the breakdown, so not listed either:
        { ...tx({ direction: 'out', counterparty: 'K market', amount: '50.00' }), status: 'PDNG' },
        { ...tx({ direction: 'out', counterparty: 'K market' }), transaction_amount: { amount: '5', currency: 'USD' } },
        { ...tx({ direction: 'out', counterparty: 'K market', amount: '0' }), credit_debit_indicator: null },
      ]),
      'EUR',
    )

    const rows = transactionsFor(counted, { direction: 'out', category: 'groceries' })
    const [groceries] = breakdownByCategory(counted, 'out')

    expect(rows).toHaveLength(groceries!.count)
    expect(rows.reduce((cents, row) => cents + Math.round(Number(row.transaction_amount.amount) * 100), 0) / 100).toBe(
      groceries!.amount,
    )
  })

  it('narrows to the selected month', () => {
    const counted = countedTransactions(
      response([
        tx({ direction: 'out', counterparty: 'K market', date: '2026-09-30' }),
        tx({ direction: 'out', counterparty: 'K market', date: '2026-10-01' }),
      ]),
    )
    expect(transactionsFor(counted, { direction: 'out', category: 'groceries', month: '2026-10' })).toHaveLength(1)
  })
})
