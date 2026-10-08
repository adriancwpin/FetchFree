import { Router } from 'express'
import * as enableBanking from '../enableBankingClient.js'
import { sessionStore } from '../sessionStore.js'

export const accountsRouter = Router()

accountsRouter.get('/', (_req, res) => {
  const session = sessionStore.getCurrentSession()
  if (!session) {
    res.status(404).send('No active bank session — complete /api/auth/start first')
    return
  }
  res.json(session.accounts)
})

accountsRouter.get('/:accountUid/balances', async (req, res) => {
  const balances = await enableBanking.getBalances(req.params.accountUid as string)
  res.json(balances)
})

accountsRouter.get('/:accountUid/transactions', async (req, res) => {
  const transactions = await enableBanking.getTransactions(req.params.accountUid as string)
  res.json(transactions)
})
