import jwt from 'jsonwebtoken'
import { config } from './config.js'

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

function authHeader(): { Authorization: string } {
  return { Authorization: `Bearer ${createJwt()}` }
}

export async function listAspsps(): Promise<unknown> {
  const response = await fetch(`${config.apiBaseUrl}/aspsps`, {
    headers: authHeader(),
  })
  return response.json()
}

export async function startAuthorization(options: {
  state: string
  redirectUrl: string
  aspspName: string
  country: string
}): Promise<{ url: string }> {
  const validUntil = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)

  const response = await fetch(`${config.apiBaseUrl}/auth`, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      access: { valid_until: validUntil.toISOString() },
      aspsp: { name: options.aspspName, country: options.country },
      state: options.state,
      redirect_url: options.redirectUrl,
      psu_type: 'personal',
    }),
  })

  return response.json()
}

export async function createSession(
  code: string,
): Promise<{ session_id: string; accounts: { uid: string }[] }> {
  const response = await fetch(`${config.apiBaseUrl}/sessions`, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  })

  return response.json()
}

export async function getBalances(accountUid: string): Promise<unknown> {
  const response = await fetch(
    `${config.apiBaseUrl}/accounts/${accountUid}/balances`,
    { headers: authHeader() },
  )
  return response.json()
}

export async function getTransactions(accountUid: string): Promise<unknown> {
  const response = await fetch(
    `${config.apiBaseUrl}/accounts/${accountUid}/transactions`,
    { headers: authHeader() },
  )
  return response.json()
}
