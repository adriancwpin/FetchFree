import * as enableBanking from './enableBankingClient.js'
import { sessionStore, type EndReason } from './sessionStore.js'

// The bank connection can't be used any more: the client shows a "Reconnect your bank" banner and
// keeps showing saved data, read-only. The error handler sends it as 401 with code SESSION_ENDED.
export class SessionEndedError extends Error {
  readonly code = 'SESSION_ENDED'

  constructor() {
    super('Your bank connection has ended. Reconnect your bank to update your data.')
  }
}

// The Enable Banking session states that unambiguously mean the session is over. Anything else
// (a missing, unknown or in-between status, or "MISSING" for a 404, which a misconfigured URL could
// also cause) isn't treated as ended: wrongly ending a working connection would leave it stuck
// read-only until the user logs in to their bank again. A Map, so only these exact names match.
const ENDED_STATUSES = new Map<string, EndReason>([
  ['EXPIRED', 'expired'],
  ['REVOKED', 'revoked'],
  ['CLOSED', 'closed'],
])

// Checks in progress, by session, so requests refused at the same time share one status call.
const checking = new Map<string, Promise<string>>()

function sessionStatus(sessionId: string): Promise<string> {
  let running = checking.get(sessionId)
  if (!running) {
    running = enableBanking.getSessionStatus(sessionId).finally(() => checking.delete(sessionId))
    checking.set(sessionId, running)
  }
  return running
}

// Called when the bank refuses an account-data request. A 401/403 alone doesn't prove the session
// ended (a 401 also means our own JWT was rejected), so ask Enable Banking for the session's state,
// every time: a session that was fine a minute ago can have been revoked since. If it says the
// session is over, record why and throw SessionEndedError; otherwise, or if that check fails too,
// rethrow the original error so its real message comes through.
export async function confirmEnded(sessionId: string, err: unknown): Promise<never> {
  const refused =
    err instanceof enableBanking.EnableBankingError && err.status >= 400 && err.status < 500 && err.status !== 429
  if (!refused) throw err

  let status: string
  try {
    status = await sessionStatus(sessionId)
  } catch {
    throw err
  }
  const reason = ENDED_STATUSES.get(status)
  if (!reason) throw err

  console.warn(`Bank session ${sessionId} is ${status}; showing saved data until the user reconnects`)
  sessionStore.markEnded(sessionId, reason)
  throw new SessionEndedError()
}
