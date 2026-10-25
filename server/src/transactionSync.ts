import * as enableBanking from './enableBankingClient.js'
import {
  earlierDate,
  laterDate,
  transactionStore,
  type AccountSync,
  type Gap,
  type StoredTransaction,
} from './transactionStore.js'

// Months of history to return, including the current month. The response reports the window
// actually covered, so the client never needs its own copy of this.
const HISTORY_MONTHS = 6
// Many banks only allow ~90 days of history once the login is a few minutes old (PSD2).
const FALLBACK_HISTORY_DAYS = 89
// Saved data this recent is served without asking the bank.
export const FRESH_FOR_MS = 15 * 60 * 1000
// A sync re-fetches this many days before the last one, since banks sometimes book late.
export const OVERLAP_DAYS = 7
// After a failed sync, wait this long before asking the bank again by itself (Refresh still asks).
export const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export interface SessionAccount {
  uid: string
  identification_hash?: unknown
  account_id?: unknown
}

// Account uids change with every bank login, so saved data is filed under something that doesn't:
// Enable Banking's hash of the account's identifiers, else the IBAN, else (last resort) the uid.
export function accountKey(account: SessionAccount): string {
  if (typeof account.identification_hash === 'string' && account.identification_hash) {
    return `hash:${account.identification_hash}`
  }
  const iban = (account.account_id as { iban?: unknown } | null | undefined)?.iban
  if (typeof iban === 'string' && iban) return `iban:${iban}`
  return `uid:${account.uid}`
}

export interface AccountTransactions {
  transactions: StoredTransaction[]
  // The window the transactions cover (YYYY-MM-DD). dateTo is the server's UTC date; the client
  // treats it as a minimum end, because a user ahead of UTC can already have "tomorrow's" entries.
  dateFrom: string
  dateTo: string
  truncated: boolean
  lastSyncedAt: string
  // Set while the bank can't be reached and saved transactions are shown instead.
  syncError: string | null
  // Dates inside the window where some transactions may be missing (see transactionStore).
  gap: Gap | null
}

// First day of the oldest month returned.
function windowStart(now: Date): string {
  return toDateString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1)))
}

function daysBefore(date: Date, days: number): string {
  return toDateString(new Date(date.getTime() - days * DAY_MS))
}

// Failures that may pass by themselves: the bank or Enable Banking is down, slow or rate-limiting.
// Others (e.g. 401/403 for an expired or revoked consent) need the user to act, so they're shown.
function isTemporary(err: unknown): err is enableBanking.EnableBankingError {
  return err instanceof enableBanking.EnableBankingError && (err.status >= 500 || err.status === 429)
}

// Asks the bank for the full window the first time, then only for what's new since the last sync,
// and saves it. `previous` is the account's sync record, read once by the caller.
async function sync(
  account: SessionAccount,
  key: string,
  previous: AccountSync | null,
  psuHeaders: enableBanking.PsuHeaders,
  now: Date,
  start: string,
): Promise<AccountSync> {
  // The bank won't confirm anything older than this once the login is a few minutes old.
  const confirmableFrom = daysBefore(now, FALLBACK_HISTORY_DAYS)

  // After a sync whose paging stopped early, fetch everything saved again, to fill in what it missed.
  let from = !previous
    ? start
    : previous.truncated
      ? previous.coveredFrom
      : daysBefore(new Date(previous.lastSyncedAt), OVERLAP_DAYS)
  // Reach back to the oldest saved pending entry, so the bank's answer settles it: still pending,
  // booked (and replaced) or gone. Older ones can't be confirmed and are dropped instead.
  const unsettled = transactionStore.oldestUnsettled(key)
  if (unsettled && unsettled >= confirmableFrom) from = earlierDate(from, unsettled)

  const result = await enableBanking.getTransactions(account.uid, from, confirmableFrom, psuHeaders)
  return transactionStore.save(key, previous, result.dateFrom, result.transactions as StoredTransaction[], {
    truncated: result.truncated,
    // Repairing a truncated sync, the bank wouldn't go back as far as asked: that part stays unchecked.
    unchecked: previous?.truncated && result.dateFrom > from ? { from, to: result.dateFrom } : null,
    keepFrom: start,
    dropUnsettledBefore: confirmableFrom,
  })
}

// Syncs in progress, by account key, so overlapping requests share one bank fetch and one save.
const inFlight = new Map<string, Promise<AccountSync>>()

export async function getAccountTransactions(
  account: SessionAccount,
  psuHeaders: enableBanking.PsuHeaders,
  options: { refresh?: boolean } = {},
): Promise<AccountTransactions> {
  const now = new Date()
  const start = windowStart(now)
  const key = accountKey(account)
  let current = transactionStore.getSync(key)

  const ago = (iso: string | null) => (iso ? now.getTime() - new Date(iso).getTime() : Infinity)
  // Sync unless the saved copy is fresh, or a sync failed moments ago; Refresh always syncs.
  if (
    !current ||
    options.refresh ||
    (ago(current.lastSyncedAt) >= FRESH_FOR_MS && ago(current.lastFailedAt) >= RETRY_AFTER_FAILURE_MS)
  ) {
    let running = inFlight.get(key)
    if (!running) {
      running = sync(account, key, current, psuHeaders, now, start).finally(() => inFlight.delete(key))
      inFlight.set(key, running)
    }
    try {
      current = await running
    } catch (err) {
      // With nothing saved there's nothing to show, and other errors need the user, so fail as before.
      if (!current || !isTemporary(err)) throw err
      console.warn(`Transaction sync failed for account ${account.uid}; serving saved data`, err.body)
      transactionStore.recordFailure(key, err.message)
      current = { ...current, lastError: err.message, lastFailedAt: now.toISOString() }
    }
  }

  const dateFrom = laterDate(current.coveredFrom, start)
  // Only the part of a gap inside the window that's shown.
  const gap = current.gap && current.gap.to > dateFrom ? { from: laterDate(current.gap.from, dateFrom), to: current.gap.to } : null
  return {
    transactions: transactionStore.list(key, dateFrom),
    dateFrom,
    dateTo: toDateString(now),
    truncated: current.truncated,
    lastSyncedAt: current.lastSyncedAt,
    syncError: current.lastError,
    gap,
  }
}
