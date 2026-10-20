import { z } from 'zod'

// Only the fields the UI reads are modelled; loose objects keep the rest of
// Enable Banking's payload without failing validation.

const amountSchema = z.looseObject({
  amount: z.string(),
  currency: z.string(),
})

const partySchema = z.looseObject({ name: z.string().nullish() }).nullish()

const accountSchema = z.looseObject({
  uid: z.string(),
  name: z.string().nullish(),
  product: z.string().nullish(),
  currency: z.string().nullish(),
  account_id: z.looseObject({ iban: z.string().nullish() }).nullish(),
})

const balanceSchema = z.looseObject({
  name: z.string().nullish(),
  balance_amount: amountSchema,
  balance_type: z.string().nullish(),
  reference_date: z.string().nullish(),
})

const transactionSchema = z.looseObject({
  entry_reference: z.string().nullish(),
  transaction_amount: amountSchema,
  credit_debit_indicator: z.enum(['CRDT', 'DBIT']).nullish(),
  booking_date: z.string().nullish(),
  value_date: z.string().nullish(),
  remittance_information: z.array(z.string()).nullish(),
  creditor: partySchema,
  debtor: partySchema,
})

export type Account = z.infer<typeof accountSchema>
export type Balance = z.infer<typeof balanceSchema>
export type Transaction = z.infer<typeof transactionSchema>

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const data: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed with status ${response.status}`
    throw new Error(message)
  }
  return schema.parse(data)
}

export function getStatus() {
  return request('/api/auth/status', z.object({ connected: z.boolean() }))
}

export function startAuth() {
  return request('/api/auth/start', z.object({ url: z.string() }), { method: 'POST' })
}

export function getAccounts() {
  return request('/api/accounts', z.array(accountSchema))
}

export async function getBalances(accountUid: string) {
  const data = await request(
    `/api/accounts/${encodeURIComponent(accountUid)}/balances`,
    z.object({ balances: z.array(balanceSchema) }),
  )
  return data.balances
}

export async function getTransactions(accountUid: string) {
  const data = await request(
    `/api/accounts/${encodeURIComponent(accountUid)}/transactions`,
    z.object({ transactions: z.array(transactionSchema) }),
  )
  return data.transactions
}
