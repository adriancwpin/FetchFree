import jwt from 'jsonwebtoken'
import { config } from './config.js'

export const SESSION_DAYS = 10

// Per request; without it a bank that never answers would hang the request forever.
const REQUEST_TIMEOUT_MS = 30_000

export class EnableBankingError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Enable Banking request failed with status ${status}`)
  }
}

function createJwt(): string {
  return jwt.sign(
    {
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
    },
    config.privateKey,
    {
      algorithm: 'RS256',
      keyid: config.appId,
      expiresIn: '1h',
    },
  )
}

// Identifies the user (PSU) when they're actively using the app. Some banks require these on
// account data calls, and PSD2 lets banks cap reads made *without* the user present (~4/day).
export interface PsuHeaders {
  'Psu-Ip-Address'?: string
  'Psu-User-Agent'?: string
}

async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; headers?: PsuHeaders } = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...options.headers,
      Authorization: `Bearer ${createJwt()}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
  }

  // The timeout covers the whole exchange: headers and body.
  let response: Response
  let text: string
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    text = await response.text()
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new EnableBankingError(504, { message: `No response from Enable Banking within ${REQUEST_TIMEOUT_MS / 1000}s` })
    }
    // DNS failure, refused connection, reset…
    throw new EnableBankingError(502, {
      message: `Could not reach Enable Banking: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  let data: unknown = null
  let isJson = true
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      // e.g. an HTML error page from a proxy; keep the raw text so the status isn't lost.
      data = text
      isJson = false
    }
  }

  if (!response.ok) {
    throw new EnableBankingError(response.status, data)
  }
  if (!isJson) {
    throw new EnableBankingError(502, { message: 'Enable Banking returned a non-JSON response' })
  }
  return data as T
}

// Countries this Enable Banking application is enabled for.
export async function listCountries(): Promise<string[]> {
  const data = await request<{ countries?: string[] }>('/application')
  return data.countries ?? []
}

export interface Aspsp {
  name: string
  country: string
  logo: string | null
  beta: boolean
  // Longest consent the bank allows, in seconds.
  maximumConsentValidity: number | null
}

// Banks in `country` that support personal accounts.
export async function listAspsps(country: string): Promise<Aspsp[]> {
  const params = new URLSearchParams({ country, psu_type: 'personal' })
  const data = await request<{
    aspsps?: {
      name: string
      country: string
      logo?: string | null
      beta?: boolean
      maximum_consent_validity?: number | null
    }[]
  }>(`/aspsps?${params}`)
  return (data.aspsps ?? []).map((aspsp) => ({
    name: aspsp.name,
    country: aspsp.country,
    logo: aspsp.logo ?? null,
    beta: aspsp.beta ?? false,
    maximumConsentValidity: aspsp.maximum_consent_validity ?? null,
  }))
}

export async function startAuthorization(options: {
  state: string
  redirectUrl: string
  aspsp: Aspsp
}): Promise<{ url: string }> {
  // Our usual consent length, unless the bank allows less.
  const consentMs = Math.min(
    SESSION_DAYS * 24 * 60 * 60 * 1000,
    (options.aspsp.maximumConsentValidity ?? Infinity) * 1000,
  )
  const validUntil = new Date(Date.now() + consentMs)

  return request('/auth', {
    body: {
      access: { valid_until: validUntil.toISOString() },
      aspsp: { name: options.aspsp.name, country: options.aspsp.country },
      state: options.state,
      redirect_url: options.redirectUrl,
      psu_type: 'personal',
    },
  })
}

export async function createSession(code: string): Promise<{
  session_id: string
  accounts: { uid: string }[]
  access?: { valid_until?: string }
}> {
  return request('/sessions', { body: { code } })
}

// The session's state at Enable Banking: "AUTHORIZED" while it can be used, otherwise e.g.
// "EXPIRED", "REVOKED" or "CLOSED"; "MISSING" if Enable Banking doesn't know it.
export async function getSessionStatus(sessionId: string): Promise<string> {
  try {
    const data = await request<{ status?: string }>(`/sessions/${encodeURIComponent(sessionId)}`)
    return data.status ?? 'UNKNOWN'
  } catch (err) {
    if (err instanceof EnableBankingError && err.status === 404) return 'MISSING'
    throw err
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export async function getBalances(accountUid: string, psuHeaders: PsuHeaders): Promise<unknown> {
  return request(`/accounts/${encodeURIComponent(accountUid)}/balances`, { headers: psuHeaders })
}

// Safety cap so a misbehaving continuation_key can't loop forever.
const MAX_TRANSACTION_PAGES = 20

// Statuses meaning the bank refused the requested date range (e.g. older than PSD2's ~90 days).
const DATE_RANGE_REFUSED_STATUSES = new Set([400, 422])

// Thrown when the bank refuses the date range on the first page, before any data was returned.
class DateRangeRefusedError extends Error {
  constructor(public readonly cause: EnableBankingError) {
    super(`Date range refused with status ${cause.status}`)
  }
}

// Enable Banking pages transactions via continuation_key; follow it to return the whole period.
// `truncated` is true when paging stopped early and older transactions may be missing.
async function fetchAllTransactionPages(
  accountUid: string,
  dateFrom: string,
  psuHeaders: PsuHeaders,
): Promise<{ transactions: unknown[]; truncated: boolean }> {
  const transactions: unknown[] = []
  const seenKeys = new Set<string>()
  let continuationKey: string | null | undefined

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page++) {
    const params = new URLSearchParams({ date_from: dateFrom })
    if (continuationKey) params.set('continuation_key', continuationKey)

    let data: { transactions?: unknown[]; continuation_key?: string | null }
    try {
      data = await request(`/accounts/${encodeURIComponent(accountUid)}/transactions?${params}`, {
        headers: psuHeaders,
      })
    } catch (err) {
      // Only a first-page 400/422 is about the date range; auth, rate-limit, 5xx or later-page errors are real failures.
      if (page === 0 && err instanceof EnableBankingError && DATE_RANGE_REFUSED_STATUSES.has(err.status)) {
        throw new DateRangeRefusedError(err)
      }
      throw err
    }
    transactions.push(...(data.transactions ?? []))
    continuationKey = data.continuation_key
    if (!continuationKey) return { transactions, truncated: false }

    // A repeated key would re-fetch the same page and double-count it.
    if (seenKeys.has(continuationKey)) {
      console.warn(`Bank repeated continuation_key for account ${accountUid}; stopping pagination`)
      return { transactions, truncated: true }
    }
    seenKeys.add(continuationKey)
  }

  return { transactions, truncated: true }
}

// Fetches transactions since `dateFrom`. If the bank refuses that range on the first page, retries
// once from `fallbackDateFrom`. Returns the date actually used so callers can report the real window.
export async function getTransactions(
  accountUid: string,
  dateFrom: string,
  fallbackDateFrom: string,
  psuHeaders: PsuHeaders,
): Promise<{ transactions: unknown[]; truncated: boolean; dateFrom: string }> {
  try {
    return { ...(await fetchAllTransactionPages(accountUid, dateFrom, psuHeaders)), dateFrom }
  } catch (err) {
    if (!(err instanceof DateRangeRefusedError)) throw err
    console.warn(`Transactions from ${dateFrom} refused (${err.cause.status}); retrying from ${fallbackDateFrom}`)
    try {
      return { ...(await fetchAllTransactionPages(accountUid, fallbackDateFrom, psuHeaders)), dateFrom: fallbackDateFrom }
    } catch (retryErr) {
      // Surface the bank's own error to the error handler, not the internal wrapper.
      throw retryErr instanceof DateRangeRefusedError ? retryErr.cause : retryErr
    }
  }
}
