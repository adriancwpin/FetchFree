import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db.js'
import { sessionStore } from './sessionStore.js'

const DAY_MS = 24 * 60 * 60 * 1000
const NORDEA = { name: 'Nordea', country: 'FI' }

function inDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString()
}

beforeEach(() => {
  db.exec('DELETE FROM pending_auths; DELETE FROM bank_sessions;')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pending logins', () => {
  it('returns the chosen bank once, then rejects the same state', () => {
    sessionStore.addPendingAuth('state-1', NORDEA)

    expect(sessionStore.consumePendingAuth('state-1')).toEqual({ bank: NORDEA })
    expect(sessionStore.consumePendingAuth('state-1')).toBeNull()
  })

  it('rejects a state it never issued', () => {
    expect(sessionStore.consumePendingAuth('made-up')).toBeNull()
  })

  it('expires a login after 15 minutes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
    sessionStore.addPendingAuth('state-1', NORDEA)
    sessionStore.addPendingAuth('state-2', NORDEA)

    vi.setSystemTime(new Date('2026-10-22T12:14:00Z'))
    expect(sessionStore.consumePendingAuth('state-1')).not.toBeNull()

    vi.setSystemTime(new Date('2026-10-22T12:15:01Z'))
    expect(sessionStore.consumePendingAuth('state-2')).toBeNull()
  })
})

describe('bank sessions', () => {
  it('stores the session with its bank and reads it back', () => {
    sessionStore.setCurrentSession({
      sessionId: 's1',
      accounts: [{ uid: 'acc-1' }],
      validUntil: inDays(10),
      bank: NORDEA,
    })

    expect(sessionStore.getCurrentSession()).toMatchObject({
      sessionId: 's1',
      accounts: [{ uid: 'acc-1' }],
      bank: NORDEA,
    })
  })

  it('normalises valid_until so a differently formatted date still compares correctly', () => {
    sessionStore.setCurrentSession({
      sessionId: 's1',
      accounts: [],
      // Enable Banking style: microseconds and an explicit offset.
      validUntil: '2099-01-01T12:00:00.000000+00:00',
      bank: null,
    })

    expect(sessionStore.getCurrentSession()?.validUntil).toBe('2099-01-01T12:00:00.000Z')
  })

  it('ignores an expired session', () => {
    sessionStore.setCurrentSession({ sessionId: 'old', accounts: [], validUntil: inDays(-1), bank: null })

    expect(sessionStore.getCurrentSession()).toBeNull()
  })

  it('replaces every old session and returns only the live ones to revoke', () => {
    // Rows as older versions of the app could leave them: several at once.
    const insert = db.prepare(
      'INSERT INTO bank_sessions (session_id, accounts, valid_until, created_at) VALUES (?, ?, ?, ?)',
    )
    insert.run('live-a', '[]', inDays(5), inDays(-2))
    insert.run('live-b', '[]', inDays(6), inDays(-1))
    insert.run('expired', '[]', inDays(-1), inDays(-9))

    const replaced = sessionStore.setCurrentSession({
      sessionId: 'new',
      accounts: [],
      validUntil: inDays(10),
      bank: NORDEA,
    })

    expect(replaced.sort()).toEqual(['live-a', 'live-b'])
    expect(db.prepare('SELECT session_id FROM bank_sessions').all()).toEqual([{ session_id: 'new' }])
  })

  it('clears every session on disconnect and returns the live ids', () => {
    sessionStore.setCurrentSession({ sessionId: 's1', accounts: [], validUntil: inDays(10), bank: null })

    expect(sessionStore.clearSessions()).toEqual(['s1'])
    expect(sessionStore.getCurrentSession()).toBeNull()
  })
})

describe('ended sessions', () => {
  it('keeps an ended session as the latest, with its reason, but not as the live one', () => {
    sessionStore.setCurrentSession({ sessionId: 's1', accounts: [{ uid: 'acc-1' }], validUntil: inDays(10), bank: NORDEA })
    sessionStore.markEnded('s1', 'revoked')

    expect(sessionStore.getCurrentSession()).toBeNull()
    expect(sessionStore.getLatestSession()).toMatchObject({ sessionId: 's1', bank: NORDEA, ended: 'revoked' })
  })

  it('reports a session past its valid_until as expired', () => {
    sessionStore.setCurrentSession({ sessionId: 's1', accounts: [], validUntil: inDays(-1), bank: NORDEA })
    expect(sessionStore.getLatestSession()?.ended).toBe('expired')
  })

  it('reports a live session as not ended', () => {
    sessionStore.setCurrentSession({ sessionId: 's1', accounts: [], validUntil: inDays(1), bank: null })
    expect(sessionStore.getLatestSession()?.ended).toBeNull()
  })

  it("doesn't try to revoke an ended session at the bank", () => {
    sessionStore.setCurrentSession({ sessionId: 's1', accounts: [], validUntil: inDays(10), bank: null })
    sessionStore.markEnded('s1', 'closed')

    expect(sessionStore.clearSessions()).toEqual([])
  })

  it('is replaced by the next connection', () => {
    sessionStore.setCurrentSession({ sessionId: 's1', accounts: [], validUntil: inDays(10), bank: null })
    sessionStore.markEnded('s1', 'revoked')
    sessionStore.setCurrentSession({ sessionId: 's2', accounts: [], validUntil: inDays(10), bank: null })

    expect(sessionStore.getLatestSession()).toMatchObject({ sessionId: 's2', ended: null })
  })
})
