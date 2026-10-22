import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getStatus } from '@/lib/api'

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
      validUntil: '2026-11-01T00:00:00.000Z',
      bank: { name: 'Nordea', country: 'FI' },
      loginUrl: 'http://localhost:3000/login',
    }
    respond(status)

    expect(await getStatus()).toEqual(status)
  })
})
