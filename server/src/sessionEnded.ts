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

const REASONS: Record<string, EndReason> = { EXPIRED: 'expired', REVOKED: 'revoked', CLOSED: 'closed' }

// Called when the bank refuses an account-data request. A 401/403 alone doesn't prove the session
// ended (a 401 also means our own JWT was rejected), so ask Enable Banking for the session's state.
// If it's no longer authorized, record why and throw SessionEndedError; otherwise, or if that check
// fails too, rethrow the original error so its real message comes through.
export async function confirmEnded(sessionId: string, err: unknown): Promise<never> {
  const refused =
    err instanceof enableBanking.EnableBankingError && err.status >= 400 && err.status < 500 && err.status !== 429
  if (!refused) throw err

  let status: string
  try {
    status = await enableBanking.getSessionStatus(sessionId)
  } catch {
    throw err
  }
  if (status === 'AUTHORIZED') throw err

  console.warn(`Bank session ${sessionId} is ${status}; showing saved data until the user reconnects`)
  sessionStore.markEnded(sessionId, REASONS[status] ?? 'ended')
  throw new SessionEndedError()
}
