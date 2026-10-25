import { Router, type NextFunction, type Request, type Response } from 'express'
import * as enableBanking from '../enableBankingClient.js'
import { confirmEnded, SessionEndedError } from '../sessionEnded.js'
import { sessionStore, type LatestSession } from '../sessionStore.js'
import { budgetStore } from '../budgetStore.js'
import {
  accountKey,
  getAccountTransactions,
  getSavedTransactions,
  type SessionAccount,
} from '../transactionSync.js'

export const accountsRouter = Router()

// An ended session's accounts are still listed, so their saved data can be shown read-only.
accountsRouter.get('/', (_req, res) => {
  const session = sessionStore.getLatestSession()
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

// Only serve accounts that belong to the latest session (live or ended). The account and the
// session are passed on in res.locals.
function requireSessionAccount(req: Request, res: Response, next: NextFunction): void {
  const session = sessionStore.getLatestSession()
  const account = session?.accounts.find((candidate) => candidate.uid === req.params.accountUid)
  if (!session || !account) {
    res.status(404).json({ error: 'Unknown account' })
    return
  }
  res.locals.account = account
  res.locals.session = session
  next()
}

function sessionOf(res: Response): LatestSession {
  return res.locals.session as LatestSession
}

// Every route that asks the bank goes through this. An ended session never reaches the bank, and a
// refusal from the bank is checked with Enable Banking, so the client learns the connection has
// ended (SESSION_ENDED) whichever route notices first.
async function callBank<T>(res: Response, call: () => Promise<T>): Promise<T> {
  const session = sessionOf(res)
  if (session.ended) throw new SessionEndedError()
  try {
    return await call()
  } catch (err) {
    return confirmEnded(session.sessionId, err)
  }
}

// Balances are only ever live from the bank, so there's nothing to show once the session has ended.
accountsRouter.get('/:accountUid/balances', requireSessionAccount, async (req, res) => {
  res.json(await callBank(res, () => enableBanking.getBalances(req.params.accountUid as string, psuHeaders(req))))
})

// Served from the saved copy; the bank is only asked for what's new (see transactionSync.ts).
// ?refresh=true asks the bank even if the saved copy is recent. Once the session has ended, only
// the saved copy is served.
accountsRouter.get('/:accountUid/transactions', requireSessionAccount, async (req, res) => {
  const account = res.locals.account as SessionAccount
  if (sessionOf(res).ended) {
    const saved = getSavedTransactions(account)
    if (!saved) throw new SessionEndedError()
    res.json(saved)
    return
  }
  const refresh = req.query.refresh === 'true'
  res.json(await callBank(res, () => getAccountTransactions(account, psuHeaders(req), { refresh })))
})

// Budgets: a monthly spending limit per category (see budgetStore.ts).
const CATEGORY_ID = /^[a-z][a-zA-Z]{0,39}$/
const MAX_BUDGET = 1_000_000_000

function budgetKey(res: Response): string {
  return accountKey(res.locals.account as SessionAccount)
}

// Whole cents from a request amount, or a message saying what's wrong with it.
function parseBudgetAmount(value: unknown): { cents: number } | { error: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: 'amount must be a number' }
  if (value <= 0 || value > MAX_BUDGET) return { error: `amount must be more than 0 and at most ${MAX_BUDGET}` }
  const cents = Math.round(value * 100)
  // Allow for floating-point noise (e.g. 0.1 + 0.2), but not a third decimal place.
  if (Math.abs(value * 100 - cents) > 1e-6) return { error: 'amount can have at most 2 decimal places' }
  return { cents }
}

accountsRouter.get('/:accountUid/budgets', requireSessionAccount, (_req, res) => {
  res.json(budgetStore.list(budgetKey(res)))
})

// Other websites can't change budgets: browsers only send a cross-site PUT or DELETE (or a JSON
// body) after a CORS preflight, which only the client's origin passes, and HTML forms can't send them.
accountsRouter.put('/:accountUid/budgets/:category', requireSessionAccount, (req, res) => {
  const category = req.params.category as string
  if (!CATEGORY_ID.test(category)) {
    res.status(400).json({ error: 'Unknown category' })
    return
  }
  const amount = parseBudgetAmount((req.body as { amount?: unknown } | undefined)?.amount)
  if ('error' in amount) {
    res.status(400).json({ error: amount.error })
    return
  }
  res.json(budgetStore.set(budgetKey(res), category, amount.cents))
})

accountsRouter.delete('/:accountUid/budgets/:category', requireSessionAccount, (req, res) => {
  budgetStore.remove(budgetKey(res), req.params.category as string)
  res.status(204).end()
})
