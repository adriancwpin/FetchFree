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
  // BOOK (settled) or PDNG (pending), among others.
  status: z.string().nullish(),
  booking_date: z.string().nullish(),
  value_date: z.string().nullish(),
  remittance_information: z.array(z.string()).nullish(),
  creditor: partySchema,
  debtor: partySchema,
})

export type Account = z.infer<typeof accountSchema>
export type Balance = z.infer<typeof balanceSchema>
export type Transaction = z.infer<typeof transactionSchema>

// `retryable` tells the retry policy whether trying again could help: only server errors (5xx)
// are worth it. 4xx and malformed responses fail the same way every time, and each retry of
// transactions can mean many bank calls.
export class ApiError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.retryable = retryable
  }
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const data: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed with status ${response.status}`
    throw new ApiError(message, response.status >= 500)
  }

  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    // Log the details for debugging; show the user something readable.
    console.error(`Unexpected response from ${path}`, parsed.error)
    throw new ApiError('The server sent data in an unexpected format.', false)
  }
  return parsed.data
}

const statusSchema = z.object({
  connected: z.boolean(),
  validUntil: z.string().nullable(),
  // Server page that starts a bank login; the browser navigates there.
  loginUrl: z.string(),
})

export type Status = z.infer<typeof statusSchema>

export function getStatus() {
  return request('/api/auth/status', statusSchema)
}

export async function disconnect() {
  const response = await fetch('/api/auth/session', { method: 'DELETE' })
  if (!response.ok) {
    throw new ApiError(`Disconnect failed with status ${response.status}`, response.status >= 500)
  }
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

const transactionsResponseSchema = z.object({
  transactions: z.array(transactionSchema),
  // The window the server actually fetched (YYYY-MM-DD); it may be shorter if the bank refused 6 months.
  dateFrom: z.string(),
  dateTo: z.string(),
  // True when the server hit its page cap and older transactions may be missing.
  truncated: z.boolean(),
})

export type TransactionsResponse = z.infer<typeof transactionsResponseSchema>

export function getTransactions(accountUid: string) {
  return request(
    `/api/accounts/${encodeURIComponent(accountUid)}/transactions`,
    transactionsResponseSchema,
  )
}
