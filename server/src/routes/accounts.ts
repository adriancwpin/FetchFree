import { Router, type NextFunction, type Request, type Response } from 'express'
import * as enableBanking from '../enableBankingClient.js'
import { sessionStore } from '../sessionStore.js'
import { getAccountTransactions, type SessionAccount } from '../transactionSync.js'

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

// Only proxy accounts that belong to the current session. The account is passed on in res.locals.
function requireSessionAccount(req: Request, res: Response, next: NextFunction): void {
  const session = sessionStore.getCurrentSession()
  const account = session?.accounts.find((candidate) => candidate.uid === req.params.accountUid)
  if (!account) {
    res.status(404).json({ error: 'Unknown account' })
    return
  }
  res.locals.account = account
  next()
}

accountsRouter.get('/:accountUid/balances', requireSessionAccount, async (req, res) => {
  const balances = await enableBanking.getBalances(req.params.accountUid as string, psuHeaders(req))
  res.json(balances)
})

// Served from the saved copy; the bank is only asked for what's new (see transactionSync.ts).
// ?refresh=true asks the bank even if the saved copy is recent.
accountsRouter.get('/:accountUid/transactions', requireSessionAccount, async (req, res) => {
  const account = res.locals.account as SessionAccount
  res.json(await getAccountTransactions(account, psuHeaders(req), { refresh: req.query.refresh === 'true' }))
})
