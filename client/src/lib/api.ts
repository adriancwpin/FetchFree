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
  // The bank's own transaction type, e.g. "Korttiosto" (card purchase); used for categories.
  bank_transaction_code: z.looseObject({ description: z.string().nullish() }).nullish(),
  creditor: partySchema,
  debtor: partySchema,
})

export type Account = z.infer<typeof accountSchema>
export type Balance = z.infer<typeof balanceSchema>
export type Transaction = z.infer<typeof transactionSchema>

// `retryable` tells the retry policy whether trying again could help: only server errors (5xx)
// are worth it. 4xx and malformed responses fail the same way every time, and each retry of
// transactions can mean many bank calls.
// `code` is set when the server names the problem, e.g. "SESSION_ENDED" when the bank connection
// can't be used any more.
export class ApiError extends Error {
  readonly retryable: boolean
  readonly code: string | undefined

  constructor(message: string, retryable: boolean, code?: string) {
    super(message)
    this.retryable = retryable
    this.code = code
  }
}

// The server's error responses: { error: "message", code?: "SESSION_ENDED" }.
const errorBodySchema = z.looseObject({ error: z.string().optional(), code: z.string().optional() })

// The error code for "the bank connection has ended" (see server/src/sessionEnded.ts).
export const SESSION_ENDED = 'SESSION_ENDED'

let sessionEndedListener: (() => void) | null = null

// Called on every response that says the bank connection has ended, including retried requests,
// before the error is thrown. Set once at startup (main.tsx) to switch the app to read-only.
export function onSessionEnded(listener: () => void): void {
  sessionEndedListener = listener
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const data: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const body = errorBodySchema.safeParse(data)
    const message = body.success && body.data.error ? body.data.error : `Request failed with status ${response.status}`
    const code = body.success ? body.data.code : undefined
    if (code === SESSION_ENDED) sessionEndedListener?.()
    throw new ApiError(message, response.status >= 500, code)
  }

  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    // Log the details for debugging; show the user something readable.
    console.error(`Unexpected response from ${path}`, parsed.error)
    throw new ApiError('The server sent data in an unexpected format.', false)
  }
  return parsed.data
}

// A 204 No Content answer: request() reads its empty body as null.
const noContentSchema = z.null()

const bankRefSchema =z.object({ name: z.string(), country: z.string() })

// The server's EndReason (server/src/sessionStore.ts), plus "ended" for any reason this client
// doesn't know yet.
export const END_REASONS = ['expired', 'revoked', 'closed', 'ended'] as const
export type EndReason = (typeof END_REASONS)[number]

const statusSchema = z.object({
  connected: z.boolean(),
  // Why the latest connection can't be used any more, or null. While set, saved data is shown
  // read-only with a "Reconnect your bank" banner. A reason this client doesn't know yet reads as
  // the generic "ended" rather than failing the whole status.
  ended: z.enum(END_REASONS).catch('ended').nullable(),
  validUntil: z.string().nullable(),
  // The connected bank; null for connections made before the bank was recorded.
  bank: bankRefSchema.nullable(),
  // Server page that starts a bank login; the browser navigates there.
  loginUrl: z.string(),
})

export type Status = z.infer<typeof statusSchema>

// Where the browser goes to start a login with `bank` (a navigation, not a fetch: see /login).
export function bankLoginHref(loginUrl: string, bank: { name: string; country: string }): string {
  return `${loginUrl}?${new URLSearchParams({ bank: bank.name, country: bank.country })}`
}

export function getStatus() {
  return request('/api/auth/status', statusSchema)
}

export async function disconnect() {
  const response = await fetch('/api/auth/session', { method: 'DELETE' })
  if (!response.ok) {
    throw new ApiError(`Disconnect failed with status ${response.status}`, response.status >= 500)
  }
}

export function getCountries() {
  return request('/api/banks/countries', z.array(z.string()))
}

const bankSchema = z.object({
  name: z.string(),
  country: z.string(),
  logo: z.string().nullable(),
  beta: z.boolean(),
})

export type Bank = z.infer<typeof bankSchema>

export function getBanks(country: string) {
  return request(`/api/banks?${new URLSearchParams({ country })}`, z.array(bankSchema))
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
  // The server answers from its saved copy: when it last got them from the bank (ISO time), and
  // why it couldn't just now, if it tried and failed.
  lastSyncedAt: z.string(),
  syncError: z.string().nullable(),
  // Dates in the window with nothing saved (`to` exclusive), left when the bank could no longer go
  // back far enough after a long break.
  gap: z.object({ from: z.string(), to: z.string() }).nullable(),
})

export type TransactionsResponse = z.infer<typeof transactionsResponseSchema>

const budgetSchema = z.object({ category: z.string(), amount: z.number() })

// A monthly spending limit for one category, in the account's currency.
export type Budget = z.infer<typeof budgetSchema>

function budgetsPath(accountUid: string, category?: string) {
  const base = `/api/accounts/${encodeURIComponent(accountUid)}/budgets`
  return category ? `${base}/${encodeURIComponent(category)}` : base
}

export function getBudgets(accountUid: string) {
  return request(budgetsPath(accountUid), z.array(budgetSchema))
}

export function setBudget(accountUid: string, category: string, amount: number) {
  return request(budgetsPath(accountUid, category), budgetSchema, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  })
}

export async function deleteBudget(accountUid: string, category: string) {
  await request(budgetsPath(accountUid, category), noContentSchema, { method: 'DELETE' })
}

const categoryRuleSchema = z.object({ direction: z.enum(['in', 'out']), payee: z.string(), category: z.string() })

// The user's own category for everything from one payee (`payee` is categories.ts's Payee key).
export type CategoryRule = z.infer<typeof categoryRuleSchema>

function categoryRulesPath(accountUid: string) {
  return `/api/accounts/${encodeURIComponent(accountUid)}/category-rules`
}

export function getCategoryRules(accountUid: string) {
  return request(categoryRulesPath(accountUid), z.array(categoryRuleSchema))
}

export function setCategoryRule(accountUid: string, rule: CategoryRule) {
  return request(categoryRulesPath(accountUid), categoryRuleSchema, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  })
}

export async function deleteCategoryRule(accountUid: string, rule: Pick<CategoryRule, 'direction' | 'payee'>) {
  await request(categoryRulesPath(accountUid), noContentSchema, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction: rule.direction, payee: rule.payee }),
  })
}

// `refresh` asks the server to check with the bank even if its saved copy is recent.
export function getTransactions(accountUid: string, options: { refresh?: boolean } = {}) {
  const query = options.refresh ? '?refresh=true' : ''
  return request(
    `/api/accounts/${encodeURIComponent(accountUid)}/transactions${query}`,
    transactionsResponseSchema,
  )
}
