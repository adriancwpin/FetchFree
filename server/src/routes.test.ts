import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBank, json, type FakeCall } from '../test/fakeBank.js'
import { app } from './app.js'
import { db } from './db.js'
import { sessionStore } from './sessionStore.js'

const CLIENT = 'http://localhost:5173/'
const BANK_LOGIN_URL = 'https://bank.example/login'

// A fake Enable Banking that knows two Finnish banks and accepts the code "good-code".
function fakeEnableBanking(): FakeCall[] {
  return fakeBank((call) => {
    if (call.path === '/application') return json({ countries: ['FI', 'SE'] })
    if (call.path === '/aspsps') {
      return json({
        aspsps: [
          { name: 'Nordea', country: 'FI', logo: 'https://logo/nordea', beta: false },
          { name: 'Genome', country: 'FI', logo: null, beta: true },
        ],
      })
    }
    if (call.path === '/auth') return json({ url: BANK_LOGIN_URL })
    if (call.path === '/sessions' && call.method === 'POST') {
      return (call.body as { code: string }).code === 'good-code'
        ? json({ session_id: 'new-session', accounts: [{ uid: 'acc-1' }] })
        : json({ message: 'bad code' }, 422)
    }
    if (call.path.startsWith('/sessions/') && call.method === 'DELETE') return json({})
    if (call.path.endsWith('/balances')) return json({ balances: [] })
    return json({ message: 'not found' }, 404)
  })
}

// Starts a login the way the Connect link does; returns the state and the browser's cookie.
async function startLogin(calls: FakeCall[]): Promise<{ state: string; cookie: string }> {
  const res = await request(app).get('/login?bank=Nordea&country=FI').set('Sec-Fetch-Dest', 'document')
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe(BANK_LOGIN_URL)

  const auth = calls.findLast((call) => call.path === '/auth')
  const state = (auth!.body as { state: string }).state
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find((value) => value.startsWith(`fetchfree_auth_${state}=`))
  expect(cookie, 'state cookie').toBeDefined()
  return { state, cookie: cookie!.split(';')[0]! }
}

function redirectParams(location: string): URLSearchParams {
  expect(location.startsWith(CLIENT)).toBe(true)
  return new URL(location).searchParams
}

let calls: FakeCall[]

beforeEach(() => {
  db.exec('DELETE FROM pending_auths; DELETE FROM bank_sessions;')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  calls = fakeEnableBanking()
})

describe('GET /api/banks', () => {
  it('lists the banks of a supported country', async () => {
    const res = await request(app).get('/api/banks?country=fi')
    expect(res.status).toBe(200)
    expect(res.body.map((bank: { name: string }) => bank.name)).toEqual(['Genome', 'Nordea'])
  })

  it.each(['XX', ''])('rejects an unsupported country (%j) with 400', async (country) => {
    const res = await request(app).get(`/api/banks?country=${country}`)
    expect(res.status).toBe(400)
  })
})

describe('GET /login', () => {
  it('redirects to the bank, saves the pending login and sets a cookie for it', async () => {
    const { state } = await startLogin(calls)
    expect(sessionStore.consumePendingAuth(state)).toEqual({ bank: { name: 'Nordea', country: 'FI' } })
  })

  it('refuses to start a login from an embedded request (another site using <img>)', async () => {
    const res = await request(app).get('/login?bank=Nordea&country=FI').set('Sec-Fetch-Dest', 'image')
    expect(res.status).toBe(403)
    expect(calls.some((call) => call.path === '/auth')).toBe(false)
  })

  it.each([
    ['an unknown bank', '/login?bank=Fake&country=FI'],
    ['an unsupported country', '/login?bank=Nordea&country=GB'],
    ['no bank at all', '/login'],
  ])('sends the user back with unknown_bank for %s', async (_case, path) => {
    const res = await request(app).get(path)
    expect(redirectParams(res.headers.location!).get('error')).toBe('unknown_bank')
  })
})

describe('GET /callback', () => {
  it('connects the bank when the state and its cookie match', async () => {
    const { state, cookie } = await startLogin(calls)

    const res = await request(app).get(`/callback?code=good-code&state=${state}`).set('Cookie', cookie)

    expect(redirectParams(res.headers.location!).get('connected')).toBe('1')
    expect(sessionStore.getCurrentSession()).toMatchObject({
      sessionId: 'new-session',
      bank: { name: 'Nordea', country: 'FI' },
    })
  })

  it('rejects a valid state without its cookie (a login link from someone else)', async () => {
    const { state } = await startLogin(calls)

    const res = await request(app).get(`/callback?code=good-code&state=${state}`)

    expect(redirectParams(res.headers.location!).get('error')).toBe('invalid_state')
    expect(sessionStore.getCurrentSession()).toBeNull()
  })

  it("rejects a state with another login's cookie", async () => {
    const first = await startLogin(calls)
    const second = await startLogin(calls)

    const res = await request(app).get(`/callback?code=good-code&state=${first.state}`).set('Cookie', second.cookie)

    expect(redirectParams(res.headers.location!).get('error')).toBe('invalid_state')
  })

  it('rejects a replayed callback', async () => {
    const { state, cookie } = await startLogin(calls)
    await request(app).get(`/callback?code=good-code&state=${state}`).set('Cookie', cookie)

    const replay = await request(app).get(`/callback?code=good-code&state=${state}`).set('Cookie', cookie)

    expect(redirectParams(replay.headers.location!).get('error')).toBe('invalid_state')
  })

  it("passes the bank's own error through when the user cancels", async () => {
    const res = await request(app).get('/callback?error=access_denied&state=whatever')
    expect(redirectParams(res.headers.location!).get('error')).toBe('access_denied')
  })

  it('reports session_failed when the bank rejects the code', async () => {
    const { state, cookie } = await startLogin(calls)

    const res = await request(app).get(`/callback?code=bad-code&state=${state}`).set('Cookie', cookie)

    expect(redirectParams(res.headers.location!).get('error')).toBe('session_failed')
  })

  it('revokes the previous connection at the bank when a new login replaces it', async () => {
    sessionStore.setCurrentSession({
      sessionId: 'old-session',
      accounts: [],
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      bank: null,
    })
    const { state, cookie } = await startLogin(calls)

    await request(app).get(`/callback?code=good-code&state=${state}`).set('Cookie', cookie)

    // The revoke runs in the background; give it a tick to be sent.
    await vi.waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.path === '/sessions/old-session')).toBe(true),
    )
  })
})

describe('status and disconnect', () => {
  it('reports the connected bank, then nothing after disconnecting', async () => {
    sessionStore.setCurrentSession({
      sessionId: 's1',
      accounts: [{ uid: 'acc-1' }],
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      bank: { name: 'Nordea', country: 'FI' },
    })

    const before = await request(app).get('/api/auth/status')
    expect(before.body).toMatchObject({ connected: true, bank: { name: 'Nordea', country: 'FI' } })

    expect((await request(app).delete('/api/auth/session')).status).toBe(204)

    const after = await request(app).get('/api/auth/status')
    expect(after.body).toMatchObject({ connected: false, bank: null })
  })
})

describe('account routes', () => {
  beforeEach(() => {
    sessionStore.setCurrentSession({
      sessionId: 's1',
      accounts: [{ uid: 'acc-1' }],
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      bank: null,
    })
  })

  it("refuses an account that isn't in the current session", async () => {
    const res = await request(app).get('/api/accounts/someone-elses/balances')
    expect(res.status).toBe(404)
    expect(calls.some((call) => call.path.includes('someone-elses'))).toBe(false)
  })

  it("sends the user's PSU headers to the bank", async () => {
    await request(app).get('/api/accounts/acc-1/balances').set('User-Agent', 'TestBrowser/1.0')

    const balances = calls.find((call) => call.path === '/accounts/acc-1/balances')
    expect(balances?.headers).toMatchObject({ 'Psu-User-Agent': 'TestBrowser/1.0' })
    expect(balances?.headers['Psu-Ip-Address']).toBeTruthy()
  })
})

describe('error handling', () => {
  it('keeps the 4xx status of a client error raised by Express (malformed JSON)', async () => {
    const res = await request(app).delete('/api/auth/session').set('Content-Type', 'application/json').send('{bad')
    expect(res.status).toBe(400)
  })

  it("passes Enable Banking's status through as JSON", async () => {
    // Balances, not the bank list: the bank list may already be cached by earlier tests.
    sessionStore.setCurrentSession({
      sessionId: 's1',
      accounts: [{ uid: 'acc-1' }],
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      bank: null,
    })
    fakeBank(() => json({ message: 'down' }, 503))
    const res = await request(app).get('/api/accounts/acc-1/balances')
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/Enable Banking/)
  })
})
