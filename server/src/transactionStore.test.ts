import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db.js'
import { transactionStore, type SaveOptions, type StoredTransaction } from './transactionStore.js'

function tx(id: string, date: string | null, status = 'BOOK'): StoredTransaction {
  return { entry_reference: id, booking_date: date, status }
}

const ids = (transactions: StoredTransaction[]) => transactions.map((transaction) => transaction.entry_reference)
const all = (account = 'a') => ids(transactionStore.list(account, '0000-01-01'))

// Nothing pruned or stale unless a test says so.
const OPTIONS: SaveOptions = { truncated: false, unchecked: null, keepFrom: '2000-01-01', dropUnsettledBefore: '2000-01-01' }

// Saves the next sync of account 'a', as if it happened on `syncedOn` (the store uses the sync
// time to spot gaps).
function saveOn(syncedOn: string, from: string, transactions: StoredTransaction[], options: Partial<SaveOptions> = {}) {
  const sync = transactionStore.save('a', transactionStore.getSync('a'), from, transactions, { ...OPTIONS, ...options })
  db.prepare('UPDATE account_syncs SET last_synced_at = ? WHERE account_key = ?').run(`${syncedOn}T12:00:00.000Z`, 'a')
  return sync
}

beforeEach(() => {
  db.exec('DELETE FROM transactions; DELETE FROM account_syncs;')
})

describe('saving a sync', () => {
  it('keeps rows older than the synced range and replaces the rest', () => {
    saveOn('2026-10-20', '2026-05-01', [tx('may', '2026-05-10'), tx('oct-old', '2026-10-20')])
    saveOn('2026-10-24', '2026-10-01', [tx('oct-new', '2026-10-20'), tx('oct-24', '2026-10-24')])

    expect(all()).toEqual(['may', 'oct-new', 'oct-24'])
  })

  it('replaces a pending transaction with its booked version in the synced range', () => {
    saveOn('2026-10-12', '2026-10-01', [tx('card', '2026-10-11', 'PDNG')])
    saveOn('2026-10-14', '2026-10-05', [tx('card-booked', '2026-10-12')])

    expect(all()).toEqual(['card-booked'])
  })

  it('keeps a pending transaction dated before the synced range, since the bank did not resend it', () => {
    saveOn('2026-10-12', '2026-10-01', [tx('older-pending', '2026-10-02', 'PDNG')])
    saveOn('2026-10-14', '2026-10-05', [])

    expect(all()).toEqual(['older-pending'])
  })

  it('drops pending transactions older than the bank can confirm', () => {
    saveOn('2026-10-12', '2026-07-01', [tx('old-pending', '2026-07-02', 'PDNG'), tx('booked', '2026-07-02')])
    saveOn('2026-10-14', '2026-10-05', [], { dropUnsettledBefore: '2026-07-17' })

    expect(all()).toEqual(['booked'])
  })

  it('replaces a saved transaction whose date the bank has since changed, by its entry_reference', () => {
    saveOn('2026-10-02', '2026-10-01', [tx('moved', '2026-10-02')])
    saveOn('2026-10-11', '2026-10-10', [tx('moved', '2026-10-11')])

    expect(transactionStore.list('a', '2026-01-01')).toEqual([tx('moved', '2026-10-11')])
  })

  it('keeps two fresh transactions that share a reference', () => {
    saveOn('2026-10-03', '2026-10-01', [tx('dup', '2026-10-02'), tx('dup', '2026-10-03')])
    expect(all()).toHaveLength(2)
  })

  it('keeps undated rows the bank did not resend, replaces exact copies, and always lists them', () => {
    saveOn('2026-10-02', '2026-10-01', [tx('undated-1', null), { note: 'no reference' }])
    saveOn('2026-10-11', '2026-10-10', [tx('undated-2', null), { note: 'no reference' }])

    expect(transactionStore.list('a', '2026-10-20')).toEqual([
      tx('undated-1', null),
      tx('undated-2', null),
      { note: 'no reference' },
    ])
  })

  it('prunes undated rows not seen since keepFrom', () => {
    saveOn('2026-10-01', '2026-10-01', [tx('undated', null)])
    db.prepare("UPDATE transactions SET saved_at = '2026-04-01T00:00:00.000Z'").run()
    saveOn('2026-10-10', '2026-10-10', [], { keepFrom: '2026-05-01' })

    expect(all()).toEqual([])
  })

  it('keeps accounts apart', () => {
    transactionStore.save('a', null, '2026-10-01', [tx('a-1', '2026-10-05')], OPTIONS)
    transactionStore.save('b', null, '2026-10-01', [tx('b-1', '2026-10-05')], OPTIONS)

    expect(all('a')).toEqual(['a-1'])
    expect(transactionStore.getSync('c')).toBeNull()
  })

  it('deletes rows older than keepFrom', () => {
    saveOn('2026-10-20', '2026-04-01', [tx('april', '2026-04-10'), tx('may', '2026-05-10')])
    const sync = saveOn('2026-11-01', '2026-10-13', [], { keepFrom: '2026-05-01' })

    expect(all()).toEqual(['may'])
    expect(sync.coveredFrom).toBe('2026-05-01')
  })
})

describe('a sync whose paging stopped early', () => {
  it('only adds and updates, never deletes what it may have missed', () => {
    saveOn('2026-10-20', '2026-10-01', [tx('a', '2026-10-05'), tx('b', '2026-10-15'), { booking_date: '2026-10-16' }])
    const sync = saveOn('2026-10-24', '2026-10-13', [tx('b', '2026-10-15'), { booking_date: '2026-10-16' }, tx('c', '2026-10-23')], {
      truncated: true,
    })

    expect(transactionStore.list('a', '0000-01-01')).toEqual([
      tx('a', '2026-10-05'),
      tx('b', '2026-10-15'),
      // An identical copy without a reference replaces the saved one rather than doubling it.
      { booking_date: '2026-10-16' },
      tx('c', '2026-10-23'),
    ])
    expect(sync.truncated).toBe(true)
  })
})

describe('coverage and gaps', () => {
  it('moves coveredFrom earlier when a sync joins up with the saved data', () => {
    saveOn('2026-10-20', '2026-07-01', [])
    expect(saveOn('2026-10-24', '2026-05-01', []).coveredFrom).toBe('2026-05-01')
    expect(saveOn('2026-10-25', '2026-10-17', []).coveredFrom).toBe('2026-05-01')
  })

  it('records a gap when the bank could not go back far enough, and keeps listing the older history', () => {
    saveOn('2026-01-20', '2025-12-01', [tx('dec', '2025-12-05')])
    const sync = saveOn('2026-05-01', '2026-02-01', [tx('feb', '2026-02-03')])

    expect(sync.gap).toEqual({ from: '2026-01-20', to: '2026-02-01' })
    expect(sync.coveredFrom).toBe('2025-12-01')
    expect(all()).toEqual(['dec', 'feb'])
  })

  it('shrinks or clears the gap when a later sync reaches back into it', () => {
    saveOn('2026-01-20', '2025-12-01', [])
    saveOn('2026-05-01', '2026-02-01', [])

    expect(saveOn('2026-05-02', '2026-01-25', []).gap).toEqual({ from: '2026-01-20', to: '2026-01-25' })
    expect(saveOn('2026-05-03', '2026-01-10', []).gap).toBeNull()
  })

  it('adds dates a repair could not check to the gap', () => {
    saveOn('2026-10-20', '2026-05-01', [], { truncated: true })
    const sync = saveOn('2026-10-25', '2026-07-28', [], { unchecked: { from: '2026-05-01', to: '2026-07-28' } })

    expect(sync).toMatchObject({ truncated: false, coveredFrom: '2026-05-01', gap: { from: '2026-05-01', to: '2026-07-28' } })
  })

  it('forgets a gap once it is older than what is kept', () => {
    saveOn('2026-01-20', '2025-12-01', [])
    saveOn('2026-05-01', '2026-02-01', [])

    expect(saveOn('2026-08-01', '2026-04-25', [], { keepFrom: '2026-03-01' }).gap).toBeNull()
  })
})

describe('failures', () => {
  it('remembers a failed sync until the next successful one', () => {
    saveOn('2026-10-02', '2026-10-01', [])
    transactionStore.recordFailure('a', 'down')
    expect(transactionStore.getSync('a')).toMatchObject({ lastError: 'down' })
    expect(transactionStore.getSync('a')!.lastFailedAt).toBeTruthy()

    saveOn('2026-10-03', '2026-10-01', [])
    expect(transactionStore.getSync('a')).toMatchObject({ lastError: null, lastFailedAt: null })
  })
})
