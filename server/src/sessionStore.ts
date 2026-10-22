import { db } from './db.js'

interface Account {
  uid: string
  [key: string]: unknown
}

interface CurrentSession {
  sessionId: string
  accounts: Account[]
  validUntil: string
}

// How long the user has to finish the bank login before its `state` is rejected.
const PENDING_AUTH_TTL_MS = 15 * 60 * 1000

export const sessionStore = {
  PENDING_AUTH_TTL_MS,
  addPendingAuth(state: string): void {
    db.prepare('INSERT INTO pending_auths (state, created_at) VALUES (?, ?)').run(
      state,
      new Date().toISOString(),
    )
  },
  consumePendingAuth(state: string): boolean {
    const cutoff = new Date(Date.now() - PENDING_AUTH_TTL_MS).toISOString()
    const result = db
      .prepare('DELETE FROM pending_auths WHERE state = ? AND created_at > ?')
      .run(state, cutoff)
    db.prepare('DELETE FROM pending_auths WHERE created_at <= ?').run(cutoff)
    return result.changes > 0
  },
  // Replaces every existing session (one bank connection at a time) and returns the ids of the
  // replaced sessions that are still live, so the caller can revoke them at the bank.
  setCurrentSession(session: CurrentSession): string[] {
    // Normalise to toISOString() format so SQL string comparisons against "now" are correct.
    const validUntil = new Date(session.validUntil).toISOString()

    db.exec('BEGIN')
    try {
      const replaced = liveSessionIds().filter((id) => id !== session.sessionId)
      db.exec('DELETE FROM bank_sessions')
      db.prepare(
        'INSERT INTO bank_sessions (session_id, accounts, valid_until, created_at) VALUES (?, ?, ?, ?)',
      ).run(session.sessionId, JSON.stringify(session.accounts), validUntil, new Date().toISOString())
      db.exec('COMMIT')
      return replaced
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  getCurrentSession(): CurrentSession | null {
    const row = db
      .prepare(
        'SELECT session_id, accounts, valid_until FROM bank_sessions WHERE valid_until > ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(new Date().toISOString()) as
      | { session_id: string; accounts: string; valid_until: string }
      | undefined
    if (!row) return null
    return {
      sessionId: row.session_id,
      accounts: JSON.parse(row.accounts) as Account[],
      validUntil: row.valid_until,
    }
  },
  // Deletes every session and returns the ids of those still live, for revoking at the bank.
  clearSessions(): string[] {
    const live = liveSessionIds()
    db.exec('DELETE FROM bank_sessions')
    return live
  },
}

// Expired sessions are already dead at the bank, so only these need revoking.
function liveSessionIds(): string[] {
  const rows = db
    .prepare('SELECT session_id FROM bank_sessions WHERE valid_until > ?')
    .all(new Date().toISOString()) as { session_id: string }[]
  return rows.map((row) => row.session_id)
}
