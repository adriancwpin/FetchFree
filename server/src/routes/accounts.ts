import { Router, type NextFunction, type Request, type Response } from 'express'
import * as enableBanking from '../enableBankingClient.js'
import { sessionStore } from '../sessionStore.js'
import { budgetStore } from '../budgetStore.js'
import { accountKey, getAccountTransactions, type SessionAccount } from '../transactionSync.js'

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
