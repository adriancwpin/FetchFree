import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBank, json } from '../test/fakeBank.js'
import * as enableBanking from './enableBankingClient.js'

const PSU = { 'Psu-Ip-Address': '127.0.0.1', 'Psu-User-Agent': 'TestBrowser/1.0' }
const NORDEA: enableBanking.Aspsp = {
  name: 'Nordea',
  country: 'FI',
  logo: null,
  beta: false,
  maximumConsentValidity: 180 * 24 * 60 * 60,
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

async function balancesError(): Promise<enableBanking.EnableBankingError> {
  const error = await enableBanking.getBalances('acc', PSU).catch((err: unknown) => err)
  expect(error).toBeInstanceOf(enableBanking.EnableBankingError)
  return error as enableBanking.EnableBankingError
}

describe('request errors', () => {
  it('turns a timeout into a 504', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })
    expect((await balancesError()).status).toBe(504)
  })

  it('turns a body that stalls past the timeout into a 504 too', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      },
    }))
    expect((await balancesError()).status).toBe(504)
  })

  it('turns a network failure into a 502', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    expect((await balancesError()).status).toBe(502)
  })

  it('keeps the real status of an HTML error page', async () => {
    fakeBank(() => new Response('<html>Bad Gateway</html>', { status: 503 }))
    const error = await balancesError()
    expect(error.status).toBe(503)
    expect(error.body).toBe('<html>Bad Gateway</html>')
  })

  it('rejects a successful response that is not JSON', async () => {
    fakeBank(() => new Response('<html>hello</html>', { status: 200 }))
    expect((await balancesError()).status).toBe(502)
  })

  it('accepts a JSON body that is just a string', async () => {
    fakeBank(() => json('just a string'))
    expect(await enableBanking.getBalances('acc', PSU)).toBe('just a string')
  })
})

describe('getTransactions', () => {
  it('follows continuation keys and merges every page', async () => {
    const calls = fakeBank((call) => {
      const key = call.query.get('continuation_key')
      const page = key ? Number(key) : 0
      return json({ transactions: [{ page }], continuation_key: page < 2 ? String(page + 1) : null })
    })

    const result = await enableBanking.getTransactions('acc', '2026-05-01', '2026-07-25', PSU)

    expect(result).toEqual({
      transactions: [{ page: 0 }, { page: 1 }, { page: 2 }],
      truncated: false,
      dateFrom: '2026-05-01',
    })
    expect(calls.map((call) => call.query.get('date_from'))).toEqual(['2026-05-01', '2026-05-01', '2026-05-01'])
  })

  it('sends the PSU headers on every page', async () => {
    const calls = fakeBank((call) =>
      json({ transactions: [], continuation_key: call.query.has('continuation_key') ? null : 'next' }),
    )

    await enableBanking.getTransactions('acc', '2026-05-01', '2026-07-25', PSU)

    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.headers).toMatchObject(PSU)
  })

  it('stops when the bank repeats a continuation key, instead of double-counting', async () => {
    const calls = fakeBank(() => json({ transactions: [{}], continuation_key: 'same' }))

    const result = await enableBanking.getTransactions('acc', '2026-05-01', '2026-07-25', PSU)

    expect(calls).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('stops after 20 pages and reports the result as truncated', async () => {
    let page = 0
    const calls = fakeBank(() => json({ transactions: [{}], continuation_key: `key-${page++}` }))

    const result = await enableBanking.getTransactions('acc', '2026-05-01', '2026-07-25', PSU)

    expect(calls).toHaveLength(20)
    expect(result).toMatchObject({ truncated: true })
  })

  it.each([400, 422])('retries from the fallback date when the first page is refused with %i', async (status) => {
    const calls = fakeBank((call) =>
      call.query.get('date_from') === '2026-05-01' ? json({ message: 'too old' }, status) : json({ transactions: [{}] }),
    )

    const result = await enableBanking.getTransactions('acc', '2026-05-01', '2026-07-25', PSU)

    expect(result).toMatchObject({ dateFrom: '2026-07-25', transactions: [{}] })
    expect(calls).toHaveLength(2)
  })

  it.each([401, 429, 500])('does not retry when the first page fails with %i', async (status) => {
    const calls = fakeBank(() => json({ message: 'nope' }, status))

    await expect(enableBanking.getTransactions('acc', '2026-05-01', '2026-07-25', PSU)).rejects.toMatchObject({
      status,
    })
    expect(calls).toHaveLength(1)
  })

  it('does not retry when a later page is refused, even with 400', async () => {
    const calls = fakeBank((call) =>
      call.query.has('continuation_key') ? json({}, 400) : json({ transactions: [{}], continuation_key: 'next' }),
    )

    await expect(enableBanking.getTransactions('acc', '2026-05-01', '2026-07-25', PSU)).rejects.toMatchObject({
      status: 400,
    })
    expect(calls).toHaveLength(2)
  })

  it("surfaces the bank's own error when the fallback date is refused too", async () => {
    fakeBank(() => json({ message: 'no' }, 422))

    await expect(enableBanking.getTransactions('acc', '2026-05-01', '2026-07-25', PSU)).rejects.toBeInstanceOf(
      enableBanking.EnableBankingError,
    )
  })
})

describe('startAuthorization', () => {
  function consentDays(call: { body: unknown }): number {
    const validUntil = (call.body as { access: { valid_until: string } }).access.valid_until
    return Math.round((Date.parse(validUntil) - Date.now()) / (24 * 60 * 60 * 1000))
  }

  it('asks for the chosen bank with our usual consent length', async () => {
    const calls = fakeBank(() => json({ url: 'https://bank.example/login' }))

    const result = await enableBanking.startAuthorization({ state: 's', redirectUrl: 'r', aspsp: NORDEA })

    expect(result.url).toBe('https://bank.example/login')
    expect(calls[0]!.body).toMatchObject({ aspsp: { name: 'Nordea', country: 'FI' }, state: 's', psu_type: 'personal' })
    expect(consentDays(calls[0]!)).toBe(enableBanking.SESSION_DAYS)
  })

  it("clamps the consent to the bank's maximum when that is shorter", async () => {
    const calls = fakeBank(() => json({ url: 'x' }))

    await enableBanking.startAuthorization({
      state: 's',
      redirectUrl: 'r',
      aspsp: { ...NORDEA, maximumConsentValidity: 3 * 24 * 60 * 60 },
    })

    expect(consentDays(calls[0]!)).toBe(3)
  })
})

describe('listAspsps', () => {
  it('asks for personal-account banks in one country and keeps only the fields we use', async () => {
    const calls = fakeBank(() =>
      json({
        aspsps: [{ name: 'Nordea', country: 'FI', logo: 'https://logo', beta: false, bic: 'NDEAFIHH', payments: [] }],
      }),
    )

    expect(await enableBanking.listAspsps('FI')).toEqual([
      { name: 'Nordea', country: 'FI', logo: 'https://logo', beta: false, maximumConsentValidity: null },
    ])
    expect(calls[0]!.query.get('country')).toBe('FI')
    expect(calls[0]!.query.get('psu_type')).toBe('personal')
  })
})
