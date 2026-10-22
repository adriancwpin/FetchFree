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

// Months of history to fetch, including the current month. Must match the client's summary window.
const HISTORY_MONTHS = 6

function historyStartDate(): string {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1))
  return start.toISOString().slice(0, 10)
}

accountsRouter.get('/:accountUid/transactions', requireSessionAccount, async (req, res) => {
  const transactions = await enableBanking.getTransactions(
    req.params.accountUid as string,
    historyStartDate(),
  )
  res.json(transactions)
})
