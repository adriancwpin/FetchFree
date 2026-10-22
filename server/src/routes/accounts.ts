import { Router, type NextFunction, type Request, type Response } from 'express'
import * as enableBanking from '../enableBankingClient.js'
import { sessionStore } from '../sessionStore.js'

export const accountsRouter = Router()

accountsRouter.get('/', (_req, res) => {
  const session = sessionStore.getCurrentSession()
  if (!session) {
    res.status(404).json({ error: 'No active bank session — complete /api/auth/start first' })
    return
  }
  res.json(session.accounts)
})

// Only proxy accounts that belong to the current session.
function requireSessionAccount(req: Request, res: Response, next: NextFunction): void {
  const session = sessionStore.getCurrentSession()
  const owned = session?.accounts.some((account) => account.uid === req.params.accountUid)
  if (!owned) {
    res.status(404).json({ error: 'Unknown account' })
    return
  }
  next()
}

accountsRouter.get('/:accountUid/balances', requireSessionAccount, async (req, res) => {
  const balances = await enableBanking.getBalances(req.params.accountUid as string)
  res.json(balances)
})

// Months of history to fetch, including the current month. The response reports the window
// actually used, so the client never needs its own copy of this.
const HISTORY_MONTHS = 6
// Many banks only allow ~90 days of history once the login is a few minutes old (PSD2).
const FALLBACK_HISTORY_DAYS = 89

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

accountsRouter.get('/:accountUid/transactions', requireSessionAccount, async (req, res) => {
  const accountUid = req.params.accountUid as string
  const now = new Date()
  const dateTo = toDateString(now)
  let dateFrom = toDateString(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1)),
  )

  let result
  try {
    result = await enableBanking.getTransactions(accountUid, dateFrom)
  } catch (err) {
    if (!(err instanceof enableBanking.EnableBankingError)) throw err
    // Retry once with a window most banks accept; a second failure goes to the error handler.
    console.warn(`Transactions from ${dateFrom} rejected (${err.status}); retrying with ${FALLBACK_HISTORY_DAYS} days`)
    dateFrom = toDateString(new Date(now.getTime() - FALLBACK_HISTORY_DAYS * 24 * 60 * 60 * 1000))
    result = await enableBanking.getTransactions(accountUid, dateFrom)
  }

  res.json({ ...result, dateFrom, dateTo })
})
