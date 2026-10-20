import { Router, type Response } from 'express'
import { config } from '../config.js'
import * as enableBanking from '../enableBankingClient.js'
import { sessionStore } from '../sessionStore.js'

export const authRouter = Router()

authRouter.get('/status', (_req, res) => {
  res.json({ connected: sessionStore.getCurrentSession() !== null })
})

authRouter.post('/start', async (_req, res) => {
  const state = crypto.randomUUID()
  sessionStore.addPendingAuth(state)

  const result = await enableBanking.startAuthorization({
    state,
    redirectUrl: config.callbackUrl,
    aspspName: 'Mock ASPSP',
    country: 'IE',
  })

  res.json({ url: result.url })
})

export const callbackRouter = Router()

function redirectToClient(res: Response, params: Record<string, string>): void {
  const url = new URL(config.clientOrigin)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  res.redirect(url.toString())
}

callbackRouter.get('/callback', async (req, res) => {
  const code = req.query.code
  const state = req.query.state

  if (typeof code !== 'string' || typeof state !== 'string') {
    // The bank sends `error` instead of `code` when the user declines consent.
    const error = typeof req.query.error === 'string' ? req.query.error : 'missing_code'
    redirectToClient(res, { error })
    return
  }

  if (!sessionStore.consumePendingAuth(state)) {
    redirectToClient(res, { error: 'invalid_state' })
    return
  }

  try {
    const session = await enableBanking.createSession(code)

    if (!session.accounts || session.accounts.length === 0) {
      redirectToClient(res, { error: 'no_accounts' })
      return
    }

    sessionStore.setCurrentSession({
      sessionId: session.session_id,
      accounts: session.accounts,
    })
  } catch (err) {
    console.error('Failed to create session', err)
    redirectToClient(res, { error: 'session_failed' })
    return
  }

  redirectToClient(res, { connected: '1' })
})
