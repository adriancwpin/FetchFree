import { Router, type NextFunction, type Request, type Response } from 'express'
import * as enableBanking from '../enableBankingClient.js'
import { sessionStore } from '../sessionStore.js'

export const accountsRouter = Router()

accountsRouter.get('/', (_req, res) => {
  const session = sessionStore.getCurrentSession()
  if (!session) {
    res.status(404).json({ error: 'No active bank session — connect a bank first' })
    return
  }
  res.json(session.accounts)
})

// The user is present whenever these routes run (the app only calls them while open), so tell the
// bank who they are. Locally the address is loopback. Behind a reverse proxy, req.ip is the proxy's
// address unless Express's "trust proxy" setting is configured, so set that before deploying.
function psuHeaders(req: Request): enableBanking.PsuHeaders {
  const headers: enableBanking.PsuHeaders = {}
  const ip = req.ip?.replace(/^::ffff:/, '')
  if (ip) headers['Psu-Ip-Address'] = ip
  const userAgent = req.get('user-agent')
  if (userAgent) headers['Psu-User-Agent'] = userAgent
  return headers
}

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
  const balances = await enableBanking.getBalances(req.params.accountUid as string, psuHeaders(req))
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
  const now = new Date()
  const result = await enableBanking.getTransactions(
    req.params.accountUid as string,
    toDateString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1))),
    toDateString(new Date(now.getTime() - FALLBACK_HISTORY_DAYS * 24 * 60 * 60 * 1000)),
    psuHeaders(req),
  )
  // dateTo is the server's UTC date. The client treats it as a minimum end, not a cut-off,
  // because a user ahead of UTC can already have transactions dated "tomorrow".
  res.json({ ...result, dateTo: toDateString(now) })
})
