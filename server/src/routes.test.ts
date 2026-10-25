import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBank, json, type FakeCall } from '../test/fakeBank.js'
import { app } from './app.js'
import { db } from './db.js'
import { sessionStore } from './sessionStore.js'
import { transactionStore } from './transactionStore.js'

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
  db.exec('DELETE FROM pending_auths; DELETE FROM bank_sessions; DELETE FROM transactions; DELETE FROM account_syncs; DELETE FROM budgets;')
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
    expect(sessionStore.getLatestSession()).toMatchObject({
      sessionId: 'new-session',
      ended: null,
      bank: { name: 'Nordea', country: 'FI' },
    })
  })

  it('rejects a valid state without its cookie (a login link from someone else)', async () => {
    const { state } = await startLogin(calls)

    const res = await request(app).get(`/callback?code=good-code&state=${state}`)

    expect(redirectParams(res.headers.location!).get('error')).toBe('invalid_state')
    expect(sessionStore.getLatestSession()).toBeNull()
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

describe('GET /api/accounts/:uid/transactions (saved transactions)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const today = () => new Date().toISOString().slice(0, 10)
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)

  // What the fake bank currently holds for the account, and how it answers.
  let bankTransactions: { entry_reference: string; booking_date: string; status: string }[]
  // An HTTP status the bank answers every transactions request with, e.g. 503 when it's down.
  let bankFailsWith: number | null
  let refuseOlderThanDays: number | null
  // Makes the bank repeat its continuation_key, so paging stops early (truncated).
  let repeatPages: boolean
  // While set, the bank holds its answers until this resolves.
  let bankGate: Promise<void> | null
  // What Enable Banking says about the session when the server checks it.
  let sessionStatus: string

  function connect(uid: string): void {
    sessionStore.setCurrentSession({
      sessionId: `session-${uid}`,
      accounts: [{ uid, identification_hash: 'same-account' }],
      validUntil: new Date(Date.now() + DAY_MS).toISOString(),
      bank: null,
    })
  }

  const transactionCalls = () => calls.filter((call) => call.path.endsWith('/transactions'))

  beforeEach(() => {
    bankTransactions = [{ entry_reference: 'recent', booking_date: daysAgo(2), status: 'BOOK' }]
    bankFailsWith = null
    refuseOlderThanDays = null
    repeatPages = false
    bankGate = null
    sessionStatus = 'AUTHORIZED'
    calls = fakeBank(async (call) => {
      if (call.path.startsWith('/sessions/')) return json({ status: sessionStatus })
      if (!call.path.endsWith('/transactions')) return json({ message: 'not found' }, 404)
      if (bankGate) await bankGate
      if (bankFailsWith) return json({ message: 'failed' }, bankFailsWith)
      const from = call.query.get('date_from')!
      if (refuseOlderThanDays !== null && from < daysAgo(refuseOlderThanDays)) return json({ message: 'too old' }, 400)
      const transactions = bankTransactions.filter((transaction) => transaction.booking_date >= from)
      return json(repeatPages ? { transactions, continuation_key: 'same-key' } : { transactions })
    })
    connect('acc-1')
  })

  it('fetches the 6-month window the first time and saves it', async () => {
    const res = await request(app).get('/api/accounts/acc-1/transactions')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ dateTo: today(), truncated: false, syncError: null })
    expect(res.body.dateFrom).toMatch(/^\d{4}-\d{2}-01$/)
    expect(transactionCalls()[0]!.query.get('date_from')).toBe(res.body.dateFrom)
    expect(res.body.transactions).toEqual(bankTransactions)
    expect(res.body.lastSyncedAt).toBeTruthy()
  })

  it("answers from the saved copy without asking the bank while it's fresh", async () => {
    await request(app).get('/api/accounts/acc-1/transactions')
    const res = await request(app).get('/api/accounts/acc-1/transactions')

    expect(res.body.transactions).toHaveLength(1)
    expect(transactionCalls()).toHaveLength(1)
  })

  it('on refresh, asks only for the days since the last sync (with overlap)', async () => {
    await request(app).get('/api/accounts/acc-1/transactions')
    bankTransactions.push({ entry_reference: 'new', booking_date: today(), status: 'BOOK' })

    const res = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')

    expect(transactionCalls()).toHaveLength(2)
    expect(transactionCalls()[1]!.query.get('date_from')).toBe(daysAgo(7))
    expect(res.body.transactions.map((t: { entry_reference: string }) => t.entry_reference)).toEqual(['recent', 'new'])
  })

  it('syncs again by itself once the saved copy is older than 15 minutes', async () => {
    await request(app).get('/api/accounts/acc-1/transactions')
    db.prepare('UPDATE account_syncs SET last_synced_at = ?').run(new Date(Date.now() - 16 * 60 * 1000).toISOString())

    await request(app).get('/api/accounts/acc-1/transactions')
    expect(transactionCalls()).toHaveLength(2)
  })

  it('shows the saved transactions with a note when the bank is down', async () => {
    await request(app).get('/api/accounts/acc-1/transactions')
    bankFailsWith = 503

    const res = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')

    expect(res.status).toBe(200)
    expect(res.body.transactions).toHaveLength(1)
    expect(res.body.syncError).toMatch(/503/)
  })

  it("doesn't ask a failing bank again on every load, but Refresh still does", async () => {
    await request(app).get('/api/accounts/acc-1/transactions')
    db.prepare('UPDATE account_syncs SET last_synced_at = ?').run(new Date(Date.now() - 16 * 60 * 1000).toISOString())
    bankFailsWith = 503

    await request(app).get('/api/accounts/acc-1/transactions')
    const res = await request(app).get('/api/accounts/acc-1/transactions')
    expect(transactionCalls()).toHaveLength(2)
    expect(res.body.syncError).toMatch(/503/)

    bankFailsWith = null
    const refreshed = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')
    expect(transactionCalls()).toHaveLength(3)
    expect(refreshed.body.syncError).toBeNull()
  })

  it.each([401, 403])(
    'passes a %i through when the session is still authorized (not a reason to reconnect)',
    async (status) => {
      await request(app).get('/api/accounts/acc-1/transactions')
      bankFailsWith = status

      const res = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')
      expect(res.status).toBe(status)
      expect(res.body.code).toBeUndefined()
    },
  )

  it('reports SESSION_ENDED when the bank refuses and the session is no longer authorized', async () => {
    await request(app).get('/api/accounts/acc-1/transactions')
    bankFailsWith = 403
    sessionStatus = 'REVOKED'

    const res = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_ENDED')
  })

  it('fails as before when the bank is down and nothing is saved', async () => {
    bankFailsWith = 503
    const res = await request(app).get('/api/accounts/acc-1/transactions')
    expect(res.status).toBe(503)
  })

  it('after a sync whose paging stopped early, fetches everything again until it completes', async () => {
    repeatPages = true
    const first = await request(app).get('/api/accounts/acc-1/transactions')
    expect(first.body.truncated).toBe(true)

    repeatPages = false
    const second = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')

    expect(transactionCalls().at(-1)!.query.get('date_from')).toBe(first.body.dateFrom)
    expect(second.body.truncated).toBe(false)
  })

  it('clears the warning once a repair completes, even if the bank no longer goes back 6 months', async () => {
    repeatPages = true
    const first = await request(app).get('/api/accounts/acc-1/transactions')
    expect(first.body.truncated).toBe(true)

    repeatPages = false
    refuseOlderThanDays = 89
    const second = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')

    // The part it couldn't re-check is reported as possibly missing instead.
    expect(second.body.truncated).toBe(false)
    expect(second.body.gap).toEqual({ from: first.body.dateFrom, to: daysAgo(89) })
  })

  it('reaches back to the oldest saved pending transaction, so its booked version replaces it', async () => {
    bankTransactions = [{ entry_reference: 'pending', booking_date: daysAgo(20), status: 'PDNG' }]
    await request(app).get('/api/accounts/acc-1/transactions')

    bankTransactions = [{ entry_reference: 'booked', booking_date: daysAgo(20), status: 'BOOK' }]
    const res = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')

    expect(transactionCalls().at(-1)!.query.get('date_from')).toBe(daysAgo(20))
    expect(res.body.transactions.map((t: { entry_reference: string }) => t.entry_reference)).toEqual(['booked'])
  })

  it('shares one bank fetch between requests that arrive together', async () => {
    let release!: () => void
    bankGate = new Promise((resolve) => (release = resolve))
    const both = Promise.all([
      request(app).get('/api/accounts/acc-1/transactions'),
      request(app).get('/api/accounts/acc-1/transactions?refresh=true'),
    ])
    // Wait until the first request has reached the bank, then give the second time to arrive.
    await vi.waitFor(() => expect(transactionCalls()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()

    const [a, b] = await both
    expect(transactionCalls()).toHaveLength(1)
    expect(a.body.transactions).toEqual(b.body.transactions)
  })

  it('only reports the part of a gap inside the window shown', async () => {
    const first = await request(app).get('/api/accounts/acc-1/transactions')
    db.prepare('UPDATE account_syncs SET gap_from = ?, gap_to = ?').run('2000-01-01', daysAgo(100))

    const res = await request(app).get('/api/accounts/acc-1/transactions')
    expect(res.body.gap).toEqual({ from: first.body.dateFrom, to: daysAgo(100) })
  })

  it('after a long break, keeps showing the older history and reports the missing dates', async () => {
    bankTransactions = [{ entry_reference: 'old', booking_date: daysAgo(120), status: 'BOOK' }]
    await request(app).get('/api/accounts/acc-1/transactions')
    // Last synced 100 days ago; the bank now only goes back 89 days.
    db.prepare('UPDATE account_syncs SET last_synced_at = ?').run(new Date(Date.now() - 100 * DAY_MS).toISOString())
    refuseOlderThanDays = 89

    const res = await request(app).get('/api/accounts/acc-1/transactions')

    expect(res.body.transactions.map((t: { entry_reference: string }) => t.entry_reference)).toContain('old')
    expect(res.body.gap).toEqual({ from: daysAgo(100), to: daysAgo(89) })
  })

  it('keeps the history when the bank is reconnected and the account gets a new uid', async () => {
    bankTransactions = [{ entry_reference: 'old', booking_date: daysAgo(120), status: 'BOOK' }]
    await request(app).get('/api/accounts/acc-1/transactions')

    // The new login only allows ~90 days, so the bank no longer returns the old one.
    connect('acc-2')
    refuseOlderThanDays = 89
    const res = await request(app).get('/api/accounts/acc-2/transactions?refresh=true')

    expect(res.body.transactions.map((t: { entry_reference: string }) => t.entry_reference)).toEqual(['old'])
  })

  it('reports the shorter window when the bank refuses 6 months', async () => {
    refuseOlderThanDays = 89
    const res = await request(app).get('/api/accounts/acc-1/transactions')

    expect(res.status).toBe(200)
    expect(res.body.dateFrom).toBe(daysAgo(89))
  })
})

describe('when the bank connection ends', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  let sessionStatus: string | Error
  let bankRefuses: boolean

  function connect(uid: string, validForMs = DAY_MS): void {
    sessionStore.setCurrentSession({
      sessionId: `session-${uid}`,
      accounts: [{ uid, identification_hash: 'same-account' }],
      validUntil: new Date(Date.now() + validForMs).toISOString(),
      bank: { name: 'Nordea', country: 'FI' },
    })
  }

  const bankCalls = () => calls.filter((call) => call.path.startsWith('/accounts/'))
  const status = async () => (await request(app).get('/api/auth/status')).body

  beforeEach(() => {
    sessionStatus = 'AUTHORIZED'
    bankRefuses = false
    calls = fakeBank((call) => {
      if (call.path.startsWith('/sessions/')) {
        if (sessionStatus instanceof Error) return json({ message: 'down' }, 503)
        if (sessionStatus === 'MISSING') return json({ error: 'SESSION_DOES_NOT_EXIST' }, 404)
        return json({ status: sessionStatus })
      }
      if (bankRefuses) return json({ message: 'refused' }, 401)
      if (call.path.endsWith('/balances')) return json({ balances: [] })
      if (call.path.endsWith('/transactions')) {
        return json({ transactions: [{ entry_reference: 'saved', booking_date: new Date().toISOString().slice(0, 10) }] })
      }
      return json({ message: 'not found' }, 404)
    })
    connect('acc-1')
  })

  it('confirms with Enable Banking, then reports a revoked session to the client', async () => {
    bankRefuses = true
    sessionStatus = 'REVOKED'

    const res = await request(app).get('/api/accounts/acc-1/balances')

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('SESSION_ENDED')
    expect(await status()).toMatchObject({ connected: false, ended: 'revoked', bank: { name: 'Nordea', country: 'FI' } })
  })

  it("passes the bank's error through when the session is still authorized (e.g. our JWT was rejected)", async () => {
    bankRefuses = true

    const res = await request(app).get('/api/accounts/acc-1/balances')

    expect(res.status).toBe(401)
    expect(res.body.code).toBeUndefined()
    expect(await status()).toMatchObject({ connected: true, ended: null })
  })

  it.each(['UNKNOWN', 'PENDING_AUTHORIZATION', 'INVALID', 'MISSING', 'constructor', 'toString'])(
    "doesn't end the connection when the session status is unclear (%s)",
    async (unclear) => {
      bankRefuses = true
      sessionStatus = unclear

      const res = await request(app).get('/api/accounts/acc-1/balances')

      expect(res.body.code).toBeUndefined()
      expect(await status()).toMatchObject({ connected: true, ended: null })
    },
  )

  it('measures the read-only window from the last sync, so old saved history stays in view', async () => {
    // Synced 200 days ago, with a transaction from a few days before that.
    const syncedOn = new Date(Date.now() - 200 * DAY_MS)
    const dayOf = (date: Date) => date.toISOString().slice(0, 10)
    const spentOn = dayOf(new Date(syncedOn.getTime() - 3 * DAY_MS))
    transactionStore.save('hash:same-account', null, '2000-01-01', [{ entry_reference: 'old', booking_date: spentOn }], {
      truncated: false,
      unchecked: null,
      keepFrom: '2000-01-01',
      dropUnsettledBefore: '2000-01-01',
    })
    db.prepare('UPDATE account_syncs SET last_synced_at = ?').run(syncedOn.toISOString())
    sessionStore.markEnded('session-acc-1', 'expired')

    const res = await request(app).get('/api/accounts/acc-1/transactions')

    // Ends at the last sync (later months aren't shown as empty), and starts 6 months before it.
    expect(res.body.dateTo).toBe(dayOf(syncedOn))
    expect(res.body.dateFrom <= spentOn).toBe(true)
    expect(res.body.transactions.map((t: { entry_reference: string }) => t.entry_reference)).toEqual(['old'])
  })

  it('notices a revocation straight after Enable Banking said the session was fine', async () => {
    bankRefuses = true
    await request(app).get('/api/accounts/acc-1/balances')
    expect((await status()).connected).toBe(true)

    sessionStatus = 'REVOKED'
    const res = await request(app).get('/api/accounts/acc-1/balances')

    expect(res.body.code).toBe('SESSION_ENDED')
    expect(await status()).toMatchObject({ connected: false, ended: 'revoked' })
  })

  it("passes the bank's error through when the session check itself fails", async () => {
    bankRefuses = true
    sessionStatus = new Error('down')

    const res = await request(app).get('/api/accounts/acc-1/balances')

    expect(res.status).toBe(401)
    expect(res.body.code).toBeUndefined()
    expect((await status()).connected).toBe(true)
  })

  it.each([
    ['revoked', () => sessionStore.markEnded('session-acc-1', 'revoked')],
    ['expired', () => connect('acc-1', -1000)],
  ])('once %s, serves saved data read-only without asking the bank', async (reason, end) => {
    await request(app).get('/api/accounts/acc-1/transactions')
    await request(app).put('/api/accounts/acc-1/budgets/groceries').send({ amount: 100 })
    end()
    const before = bankCalls().length

    expect(await status()).toMatchObject({ connected: false, ended: reason })
    expect((await request(app).get('/api/accounts')).body).toEqual([{ uid: 'acc-1', identification_hash: 'same-account' }])

    const transactions = await request(app).get('/api/accounts/acc-1/transactions?refresh=true')
    expect(transactions.status).toBe(200)
    expect(transactions.body.transactions).toHaveLength(1)

    const balances = await request(app).get('/api/accounts/acc-1/balances')
    expect(balances.body.code).toBe('SESSION_ENDED')

    // Budgets are our own data, so they still work.
    expect((await request(app).put('/api/accounts/acc-1/budgets/travel').send({ amount: 50 })).status).toBe(200)
    expect(bankCalls()).toHaveLength(before)
  })

  it('reports SESSION_ENDED for transactions when nothing was saved', async () => {
    sessionStore.markEnded('session-acc-1', 'closed')
    const res = await request(app).get('/api/accounts/acc-1/transactions')
    expect(res.body.code).toBe('SESSION_ENDED')
  })

  it('is live again after reconnecting, with the saved history', async () => {
    await request(app).get('/api/accounts/acc-1/transactions')
    sessionStore.markEnded('session-acc-1', 'revoked')

    connect('acc-2')

    expect(await status()).toMatchObject({ connected: true, ended: null })
    const res = await request(app).get('/api/accounts/acc-2/transactions')
    expect(res.body.transactions.map((t: { entry_reference: string }) => t.entry_reference)).toContain('saved')
  })
})

describe('budgets', () => {
  function connect(uid: string): void {
    sessionStore.setCurrentSession({
      sessionId: `session-${uid}`,
      accounts: [{ uid, identification_hash: 'same-account' }],
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      bank: null,
    })
  }

  const put = (uid: string, category: string, body: unknown) =>
    request(app).put(`/api/accounts/${uid}/budgets/${category}`).send(body as object)

  beforeEach(() => connect('acc-1'))

  it('saves, lists, replaces and removes a budget', async () => {
    expect((await put('acc-1', 'groceries', { amount: 300 })).body).toEqual({ category: 'groceries', amount: 300 })
    await put('acc-1', 'eatingOut', { amount: 80.5 })
    await put('acc-1', 'groceries', { amount: 250.25 })

    const listed = await request(app).get('/api/accounts/acc-1/budgets')
    expect(listed.body).toEqual([
      { category: 'eatingOut', amount: 80.5 },
      { category: 'groceries', amount: 250.25 },
    ])

    expect((await request(app).delete('/api/accounts/acc-1/budgets/groceries')).status).toBe(204)
    expect((await request(app).get('/api/accounts/acc-1/budgets')).body).toEqual([{ category: 'eatingOut', amount: 80.5 }])
  })

  it('keeps budgets when the bank is reconnected and the account gets a new uid', async () => {
    await put('acc-1', 'groceries', { amount: 300 })
    connect('acc-2')

    expect((await request(app).get('/api/accounts/acc-2/budgets')).body).toEqual([{ category: 'groceries', amount: 300 }])
  })

  it.each([
    ['a negative amount', 'groceries', { amount: -5 }],
    ['zero', 'groceries', { amount: 0 }],
    ['three decimal places', 'groceries', { amount: 1.005 }],
    ['a string', 'groceries', { amount: '300' }],
    ['no amount', 'groceries', {}],
    ['too large an amount', 'groceries', { amount: 2e9 }],
    ['a malformed category', 'Not-A-Category', { amount: 10 }],
  ])('rejects %s with 400', async (_case, category, body) => {
    const res = await put('acc-1', category, body)
    expect(res.status).toBe(400)
    expect(res.body.error).toBeTruthy()
    expect((await request(app).get('/api/accounts/acc-1/budgets')).body).toEqual([])
  })

  it('accepts amounts with floating-point noise, like 0.1 + 0.2', async () => {
    expect((await put('acc-1', 'groceries', { amount: 0.1 + 0.2 })).body.amount).toBe(0.3)
  })

  it('rejects a body that is not JSON', async () => {
    const res = await request(app)
      .put('/api/accounts/acc-1/budgets/groceries')
      .set('Content-Type', 'text/plain')
      .send('amount=300')
    expect(res.status).toBe(400)
  })

  it("refuses an account that isn't in the current session", async () => {
    expect((await request(app).get('/api/accounts/someone-elses/budgets')).status).toBe(404)
    expect((await put('someone-elses', 'groceries', { amount: 10 })).status).toBe(404)
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
