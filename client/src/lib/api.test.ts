import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, bankLoginHref, getStatus, getTransactions, onSessionEnded } from '@/lib/api'

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
