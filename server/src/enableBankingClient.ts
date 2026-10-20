import jwt from 'jsonwebtoken'
import { config } from './config.js'

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

async function request<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${createJwt()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  }
  if (body !== undefined) {
    init.method = 'POST'
    init.body = JSON.stringify(body)
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
  const validUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)

  return request('/auth', {
    access: { valid_until: validUntil.toISOString() },
    aspsp: { name: options.aspspName, country: options.country },
    state: options.state,
    redirect_url: options.redirectUrl,
    psu_type: 'personal',
  })
}

export async function createSession(
  code: string,
): Promise<{ session_id: string; accounts: { uid: string }[] }> {
  return request('/sessions', { code })
}

export async function getBalances(accountUid: string): Promise<unknown> {
  return request(`/accounts/${encodeURIComponent(accountUid)}/balances`)
}

export async function getTransactions(accountUid: string): Promise<unknown> {
  return request(`/accounts/${encodeURIComponent(accountUid)}/transactions`)
}
