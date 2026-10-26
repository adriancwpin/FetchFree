import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  bankLoginHref,
  deleteCategoryRule,
  getStatus,
  getTransactions,
  onSessionEnded,
  serverClock,
  setCategoryRule,
} from '@/lib/api'

function respond(body: unknown, status = 200) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('API errors and the retry policy', () => {
  it('marks server errors (5xx) as worth retrying, with the server message', async () => {
    respond({ error: 'Enable Banking request failed with status 503' }, 503)

    const error = await getStatus().catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ retryable: true, message: 'Enable Banking request failed with status 503' })
  })

  it('keeps the code the server names the problem with', async () => {
    respond({ error: 'Your bank connection has ended.', code: 'SESSION_ENDED' }, 401)
    await expect(getStatus()).rejects.toMatchObject({ code: 'SESSION_ENDED', retryable: false })
  })

  it('marks client errors (4xx) as not worth retrying', async () => {
    respond({ error: 'Unknown account' }, 404)
    await expect(getStatus()).rejects.toMatchObject({ retryable: false, message: 'Unknown account' })
  })

  it('turns a response with the wrong shape into a readable, non-retryable error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    respond({ connected: 'yes' })

    await expect(getStatus()).rejects.toMatchObject({
      retryable: false,
      message: 'The server sent data in an unexpected format.',
    })
  })

  it('returns the parsed data when the shape is right', async () => {
    const status = {
      connected: true,
      ended: null,
      validUntil: '2026-11-01T00:00:00.000Z',
      bank: { name: 'Nordea', country: 'FI' },
      loginUrl: 'http://localhost:3000/login',
    }
    respond(status)

    expect(await getStatus()).toEqual(status)
  })
})

describe('getTransactions', () => {
  it('asks the server to check with the bank only when refreshing', async () => {
    const response = {
      transactions: [],
      dateFrom: '2026-05-01',
      dateTo: '2026-10-25',
      truncated: false,
      lastSyncedAt: '2026-10-25T12:00:00.000Z',
      syncError: 'Enable Banking request failed with status 503',
      gap: { from: '2026-07-20', to: '2026-07-28' },
    }
    const fetchSpy = vi.fn(async (_path: string) => new Response(JSON.stringify(response)))
    vi.stubGlobal('fetch', fetchSpy)

    expect(await getTransactions('acc 1')).toEqual(response)
    await getTransactions('acc 1', { refresh: true })

    expect(fetchSpy.mock.calls.map(([path]) => path)).toEqual([
      '/api/accounts/acc%201/transactions',
      '/api/accounts/acc%201/transactions?refresh=true',
    ])
  })
})

describe('getStatus', () => {
  it('reads a connection-ended reason it does not know yet as the generic "ended"', async () => {
    respond({ connected: false, ended: 'cancelled', validUntil: null, bank: null, loginUrl: 'http://localhost:3000/login' })
    expect((await getStatus()).ended).toBe('ended')
  })

  const status = { connected: true, ended: null, validUntil: null, bank: null, loginUrl: 'http://localhost:3000/login' }

  // How far serverClock() is from the browser's clock, in ms.
  const measuredOffset = () => {
    const browserNow = new Date('2026-10-25T15:00:00.000Z')
    return serverClock(browserNow).getTime() - browserNow.getTime()
  }
  const THREE_HOURS = 3 * 3_600_000

  describe('with a simulated request (fake timers, so timing is exact)', () => {
    beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-25T12:00:00.000Z') }))
    afterEach(() => vi.useRealTimers())

    it("measures how far the server's clock is from the browser's, and doesn't keep serverTime", async () => {
      // The browser's clock is 3 hours fast (no time passes: Date.now() is frozen).
      respond({ ...status, serverTime: new Date(Date.now() - THREE_HOURS).toISOString() })
      expect(await getStatus()).toEqual(status)
      expect(measuredOffset()).toBe(-THREE_HOURS)

      // A later answer without a readable time keeps the last measurement.
      respond(status)
      await getStatus()
      respond({ ...status, serverTime: 'not a time' })
      await getStatus()
      expect(measuredOffset()).toBe(-THREE_HOURS)
    })

    // A request taking `roundTripMs`, to a server whose clock is `aheadMs` ahead, which stamps its
    // time `stampedAfterMs` into the request (halfway unless said).
    const answer = (roundTripMs: number, aheadMs: number, stampedAfterMs = roundTripMs / 2) =>
      vi.stubGlobal('fetch', async () => {
        const serverTime = new Date(Date.now() + stampedAfterMs + aheadMs).toISOString()
        vi.advanceTimersByTime(roundTripMs)
        return new Response(JSON.stringify({ ...status, serverTime }))
      })

    it('allows for the time the request took: the server stamped its time halfway', async () => {
      answer(200, 0)
      await getStatus()
      // Measured from when the answer arrived instead, it would look 100 ms behind.
      expect(measuredOffset()).toBe(0)
    })

    it("doesn't let a slow answer that agrees replace a more precise one", async () => {
      answer(100, 60_000)
      await getStatus()
      expect(measuredOffset()).toBe(60_000)

      // 5 seconds, stamped right at the start: its guess is 2.5 s out, within its own margin, so
      // the 100 ms measurement stays.
      answer(5000, 60_000, 0)
      await getStatus()
      expect(measuredOffset()).toBe(60_000)
    })

    it('takes a slow answer that proves the current one wrong, e.g. after a clock was corrected', async () => {
      answer(100, 60_000)
      await getStatus()

      // Every request is slow now, but the clocks are 30 s further apart than measured: more than
      // either measurement could be out by, so the old one must be out of date.
      answer(5000, 90_000)
      await getStatus()
      expect(measuredOffset()).toBe(90_000)
    })

    it('always takes a fast answer', async () => {
      answer(5000, 60_000)
      await getStatus()
      answer(100, 59_000)
      await getStatus()
      expect(measuredOffset()).toBe(59_000)
    })
  })
})

describe('onSessionEnded', () => {
  it('is told about every response saying the bank connection has ended, before the error is thrown', async () => {
    const listener = vi.fn()
    onSessionEnded(listener)
    respond({ error: 'Your bank connection has ended.', code: 'SESSION_ENDED' }, 401)

    await expect(getStatus()).rejects.toMatchObject({ code: 'SESSION_ENDED' })
    await expect(getStatus()).rejects.toMatchObject({ code: 'SESSION_ENDED' })
    expect(listener).toHaveBeenCalledTimes(2)

    respond({ error: 'Unknown account' }, 404)
    await expect(getStatus()).rejects.toBeInstanceOf(ApiError)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('bankLoginHref', () => {
  it('starts the login on the server with the bank and its country', () => {
    expect(bankLoginHref('http://localhost:3000/login', { name: 'S-Pankki & Co', country: 'FI' })).toBe(
      'http://localhost:3000/login?bank=S-Pankki+%26+Co&country=FI',
    )
  })
})

describe('category rules', () => {
  it('sends a new rule in the JSON body, and names the one to remove in the query string', async () => {
    const rule = { direction: 'out' as const, payee: 'alepa / kamppi?', category: 'eatingOut' }
    const fetchSpy = vi.fn(async (_path: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(JSON.stringify(rule)),
    )
    vi.stubGlobal('fetch', fetchSpy)

    expect(await setCategoryRule('acc 1', rule)).toEqual(rule)
    await deleteCategoryRule('acc 1', rule)

    expect(fetchSpy.mock.calls.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
      ['/api/accounts/acc%201/category-rules', 'PUT', JSON.stringify(rule)],
      ['/api/accounts/acc%201/category-rules?direction=out&payee=alepa+%2F+kamppi%3F', 'DELETE', undefined],
    ])
  })

  it("shows the server's message when removing a rule fails", async () => {
    respond({ error: 'Unknown account' }, 404)
    await expect(deleteCategoryRule('acc-1', { direction: 'out', payee: 'alepa' })).rejects.toMatchObject({
      message: 'Unknown account',
      retryable: false,
    })
  })
})
