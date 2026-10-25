import { Router, type Request, type Response } from 'express'
import * as bankDirectory from '../bankDirectory.js'
import { config } from '../config.js'
import * as enableBanking from '../enableBankingClient.js'
import { sessionStore } from '../sessionStore.js'

// Ties each OAuth `state` to the browser that started the login, so a callback link made by
// someone else (login CSRF) can't attach their bank account to this app. The login starts with a
// navigation to /login on this server, so the cookie is always set on the same host the bank
// redirects back to. Each login gets its own cookie, so two logins in parallel don't clash.
const STATE_COOKIE_PREFIX = 'fetchfree_auth_'
const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  // Lax is still sent on the bank's top-level redirect back to /callback.
  sameSite: 'lax' as const,
  path: '/callback',
}

// Cookie names only; the value is never read, so a malformed value can't break the callback.
function hasCookie(req: Request, name: string): boolean {
  return (req.headers.cookie?.split(';') ?? []).some((part) => part.trim().split('=')[0] === name)
}

// Best effort and not awaited by callers: locally the sessions are already gone, and a slow
// bank shouldn't hold up the user.
function revokeSessions(sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    enableBanking.deleteSession(sessionId).catch((err: unknown) => {
      console.error(`Failed to revoke session ${sessionId} at Enable Banking`, err)
    })
  }
}

function redirectToClient(res: Response, params: Record<string, string>): void {
  const url = new URL(config.clientOrigin)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  res.redirect(url.toString())
}

export const authRouter = Router()

// `ended` says why the latest connection can't be used any more ("expired", "revoked"…); the
// client then shows saved data read-only with a "Reconnect your bank" banner.
authRouter.get('/status', (_req, res) => {
  const session = sessionStore.getLatestSession()
  res.json({
    connected: session !== null && session.ended === null,
    ended: session?.ended ?? null,
    validUntil: session?.validUntil ?? null,
    bank: session?.bank ?? null,
    // Where the client sends the browser to start a bank login.
    loginUrl: new URL('/login', config.callbackUrl).toString(),
  })
})

authRouter.delete('/session', (_req, res) => {
  revokeSessions(sessionStore.clearSessions())
  res.status(204).end()
})

// Mounted at the server root, next to /callback, so both share the cookie host.
export const callbackRouter = Router()

// GET /login?bank=<name>&country=<CC>: starts a login with a bank chosen in the picker.
callbackRouter.get('/login', async (req, res) => {
  // Only a top-level navigation (the Connect link) may start a login. Browsers label embedded
  // requests (<img>, <script>, fetch from another site) with a different Sec-Fetch-Dest, so another
  // website can't make the browser start logins and use up Enable Banking calls.
  const fetchDest = req.get('sec-fetch-dest')
  if (fetchDest && fetchDest !== 'document') {
    res.status(403).json({ error: 'A login must be started by opening the link directly' })
    return
  }

  const bankName = typeof req.query.bank === 'string' ? req.query.bank : ''
  const country = typeof req.query.country === 'string' ? req.query.country.toUpperCase() : ''

  let url: string
  try {
    const aspsp = await bankDirectory.findBank(bankName, country)
    if (!aspsp) {
      redirectToClient(res, { error: 'unknown_bank' })
      return
    }

    const state = crypto.randomUUID()
    sessionStore.addPendingAuth(state, { name: aspsp.name, country: aspsp.country })
    const result = await enableBanking.startAuthorization({
      state,
      redirectUrl: config.callbackUrl,
      aspsp,
    })
    url = result.url
    res.cookie(`${STATE_COOKIE_PREFIX}${state}`, '1', {
      ...STATE_COOKIE_OPTIONS,
      maxAge: sessionStore.PENDING_AUTH_TTL_MS,
    })
  } catch (err) {
    console.error('Failed to start bank authorization', err)
    redirectToClient(res, { error: 'start_failed' })
    return
  }

  res.redirect(url)
})

callbackRouter.get('/callback', async (req, res) => {
  const code = req.query.code
  const state = req.query.state

  if (typeof state === 'string') {
    res.clearCookie(`${STATE_COOKIE_PREFIX}${state}`, STATE_COOKIE_OPTIONS)
  }

  if (typeof code !== 'string' || typeof state !== 'string') {
    // The bank sends `error` instead of `code` when the user declines consent.
    const error = typeof req.query.error === 'string' ? req.query.error : 'missing_code'
    redirectToClient(res, { error })
    return
  }

  // The state must be one we issued (and unused) AND one this browser started.
  const pending = hasCookie(req, `${STATE_COOKIE_PREFIX}${state}`) ? sessionStore.consumePendingAuth(state) : null
  if (!pending) {
    redirectToClient(res, { error: 'invalid_state' })
    return
  }

  let replacedSessionIds: string[]
  try {
    const session = await enableBanking.createSession(code)

    if (!session.accounts || session.accounts.length === 0) {
      redirectToClient(res, { error: 'no_accounts' })
      return
    }

    const fallbackValidUntil = new Date(
      Date.now() + enableBanking.SESSION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()

    replacedSessionIds = sessionStore.setCurrentSession({
      sessionId: session.session_id,
      accounts: session.accounts,
      validUntil: session.access?.valid_until ?? fallbackValidUntil,
      bank: pending.bank,
    })
  } catch (err) {
    console.error('Failed to create session', err)
    redirectToClient(res, { error: 'session_failed' })
    return
  }

  // A new login replaces the old connection(s); cancel them at the bank too.
  revokeSessions(replacedSessionIds)
  redirectToClient(res, { connected: '1' })
})
