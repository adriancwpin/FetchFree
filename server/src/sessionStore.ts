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

// Why a session can no longer be used. "expired" also covers passing our own valid_until.
export type EndReason = 'expired' | 'revoked' | 'closed' | 'ended'

export interface LatestSession extends CurrentSession {
  // Null while the session is live.
  ended: EndReason | null
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
  // The live session, or null if there's none or it has ended.
  getCurrentSession(): CurrentSession | null {
    const session = this.getLatestSession()
    if (!session || session.ended) return null
    const { ended: _ended, ...current } = session
    return current
  },
  // The newest session, live or ended, so an ended connection's accounts and saved data can still
  // be shown (read-only) until the user reconnects or disconnects.
  getLatestSession(): LatestSession | null {
    const row = db
      .prepare(
        `SELECT session_id, accounts, valid_until, aspsp_name, aspsp_country, ended_reason FROM bank_sessions
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as
      | {
          session_id: string
          accounts: string
          valid_until: string
          aspsp_name: string | null
          aspsp_country: string | null
          ended_reason: EndReason | null
        }
      | undefined
    if (!row) return null
    return {
      sessionId: row.session_id,
      accounts: JSON.parse(row.accounts) as Account[],
      validUntil: row.valid_until,
      bank: toBank(row.aspsp_name, row.aspsp_country),
      ended: row.ended_reason ?? (row.valid_until <= new Date().toISOString() ? 'expired' : null),
    }
  },
  // Records that the bank says this session can no longer be used.
  markEnded(sessionId: string, reason: EndReason): void {
    db.prepare('UPDATE bank_sessions SET ended_reason = ? WHERE session_id = ?').run(reason, sessionId)
  },
  // Deletes every session and returns the ids of those still live, for revoking at the bank.
  clearSessions(): string[] {
    const live = liveSessionIds()
    db.exec('DELETE FROM bank_sessions')
    return live
  },
}

// Expired or ended sessions are already dead at the bank, so only these need revoking.
function liveSessionIds(): string[] {
  const rows = db
    .prepare('SELECT session_id FROM bank_sessions WHERE valid_until > ? AND ended_reason IS NULL')
    .all(new Date().toISOString()) as { session_id: string }[]
  return rows.map((row) => row.session_id)
}
