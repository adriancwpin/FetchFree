import { db } from './db.js'

interface Account {
  uid: string
  [key: string]: unknown
}

// The bank a login or session is with (an ASPSP in Enable Banking's terms).
export interface Bank {
  name: string
  country: string
}

interface CurrentSession {
  sessionId: string
  accounts: Account[]
  validUntil: string
  // Null for sessions created before the bank was recorded.
  bank: Bank | null
}

// How long the user has to finish the bank login before its `state` is rejected.
const PENDING_AUTH_TTL_MS = 15 * 60 * 1000

function toBank(name: string | null, country: string | null): Bank | null {
  return name && country ? { name, country } : null
}

export const sessionStore = {
  PENDING_AUTH_TTL_MS,
  addPendingAuth(state: string, bank: Bank): void {
    db.prepare(
      'INSERT INTO pending_auths (state, created_at, aspsp_name, aspsp_country) VALUES (?, ?, ?, ?)',
    ).run(state, new Date().toISOString(), bank.name, bank.country)
  },
  // Single use: deletes the pending login and returns it, or null if the state is unknown,
  // already used or expired.
  consumePendingAuth(state: string): { bank: Bank | null } | null {
    const cutoff = new Date(Date.now() - PENDING_AUTH_TTL_MS).toISOString()
    const row = db
      .prepare('SELECT aspsp_name, aspsp_country FROM pending_auths WHERE state = ? AND created_at > ?')
      .get(state, cutoff) as { aspsp_name: string | null; aspsp_country: string | null } | undefined
    db.prepare('DELETE FROM pending_auths WHERE state = ? OR created_at <= ?').run(state, cutoff)
    return row ? { bank: toBank(row.aspsp_name, row.aspsp_country) } : null
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
        `INSERT INTO bank_sessions (session_id, accounts, valid_until, created_at, aspsp_name, aspsp_country)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        session.sessionId,
        JSON.stringify(session.accounts),
        validUntil,
        new Date().toISOString(),
        session.bank?.name ?? null,
        session.bank?.country ?? null,
      )
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
        `SELECT session_id, accounts, valid_until, aspsp_name, aspsp_country FROM bank_sessions
         WHERE valid_until > ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(new Date().toISOString()) as
      | {
          session_id: string
          accounts: string
          valid_until: string
          aspsp_name: string | null
          aspsp_country: string | null
        }
      | undefined
    if (!row) return null
    return {
      sessionId: row.session_id,
      accounts: JSON.parse(row.accounts) as Account[],
      validUntil: row.valid_until,
      bank: toBank(row.aspsp_name, row.aspsp_country),
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
