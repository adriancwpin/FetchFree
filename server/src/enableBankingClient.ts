import jwt from 'jsonwebtoken'
import { config } from './config.js'

export const SESSION_DAYS = 10

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

async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      Authorization: `Bearer ${createJwt()}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
  }

  const response = await fetch(`${config.apiBaseUrl}${path}`, init)
  const text = await response.text()
  const data: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    throw new EnableBankingError(response.status, data)
  }
  return data as T
}

export async function listAspsps(): Promise<unknown> {
  return request('/aspsps')
}

export async function startAuthorization(options: {
  state: string
  redirectUrl: string
  aspspName: string
  country: string
}): Promise<{ url: string }> {
  const validUntil = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)

  return request('/auth', {
    body: {
      access: { valid_until: validUntil.toISOString() },
      aspsp: { name: options.aspspName, country: options.country },
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

export async function deleteSession(sessionId: string): Promise<void> {
  await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export async function getBalances(accountUid: string): Promise<unknown> {
  return request(`/accounts/${encodeURIComponent(accountUid)}/balances`)
}

export async function getTransactions(accountUid: string): Promise<unknown> {
  return request(`/accounts/${encodeURIComponent(accountUid)}/transactions`)
}
