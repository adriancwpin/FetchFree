import { Router } from 'express'
import * as enableBanking from '../enableBankingClient.js'
import { sessionStore } from '../sessionStore.js'

// Must exactly match the redirect URI registered with Enable Banking for this app.
const CALLBACK_URL = 'http://localhost:3000/callback'

export const authRouter = Router()

authRouter.post('/start', async (_req, res) => {
  const state = crypto.randomUUID()
  sessionStore.addPendingAuth(state)

  const result = await enableBanking.startAuthorization({
    state,
    redirectUrl: CALLBACK_URL,
    aspspName: 'Mock ASPSP',
    country: 'IE',
  })

  res.json({ url: result.url })
})

export const callbackRouter = Router()

callbackRouter.get('/callback', async (req, res) => {
  const code = req.query.code
  const state = req.query.state

  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).send('Missing code or state')
    return
  }

  if (!sessionStore.consumePendingAuth(state)) {
    res.status(400).send('Unknown or expired state — possible spoofed request')
    return
  }

  const session = await enableBanking.createSession(code)

  if (!session.accounts || session.accounts.length === 0) {
    res.status(502).send('Session did not return any accounts')
    return
  }

  sessionStore.setCurrentSession({
    sessionId: session.session_id,
    accounts: session.accounts,
  })

  res.send('Success! You can close this tab.')
})
