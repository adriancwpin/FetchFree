import { createHash } from 'node:crypto'
import { db } from './db.js'

// A transaction as the bank sent it. Only the fields used to file it are named; the rest is
// stored and returned unchanged.
export interface StoredTransaction {
  entry_reference?: string | null
  booking_date?: string | null
  value_date?: string | null
  status?: string | null
  [key: string]: unknown
}

// Dates where some transactions may be missing: `from` inclusive, `to` exclusive (YYYY-MM-DD).
export interface Gap {
  from: string
  to: string
}

export interface AccountSync {
  // Earliest date the saved data starts from. Complete from there, except for `gap`.
  coveredFrom: string
  // Left when the bank could no longer go back far enough to join up with, or repair, saved data.
  gap: Gap | null
  lastSyncedAt: string
  // The last sync's paging stopped early, so some transactions may be missing.
  truncated: boolean
  // Set while the latest attempt failed (cleared by the next successful sync).
  lastError: string | null
  lastFailedAt: string | null
}

export interface SaveOptions {
  truncated: boolean
  // The sync asked for an earlier start than `from` to repair saved data, but the bank refused:
  // these dates couldn't be checked.
  unchecked: Gap | null
  // Rows dated (or, if undated, last saved) before this are deleted: older than anything shown.
  keepFrom: string
  // Unsettled rows dated before this are deleted: the bank won't go back far enough to confirm them.
  dropUnsettledBefore: string
}

export const earlierDate = (a: string, b: string) => (a < b ? a : b)
export const laterDate = (a: string, b: string) => (a > b ? a : b)

// The same date the client groups by (summary.ts dateOf).
function dateOf(transaction: StoredTransaction): string | null {
  return transaction.booking_date ?? transaction.value_date ?? null
}

// Identifies an exact copy of a transaction; indexed, unlike the JSON itself.
function fingerprint(json: string): string {
  return createHash('sha256').update(json).digest('hex')
}

function mergeGaps(a: Gap | null, b: Gap | null): Gap | null {
  if (!a || !b) return a ?? b
  // Only one gap is tracked, so two are merged into one (reporting a little too much as missing).
  return { from: earlierDate(a.from, b.from), to: laterDate(a.to, b.to) }
}

// Where the saved data starts and what may be missing, after saving a fetch from `from` to today.
function coverageAfter(previous: AccountSync | null, from: string, options: SaveOptions) {
  let gap: Gap | null = null
  let coveredFrom = from
  if (previous) {
    coveredFrom = earlierDate(previous.coveredFrom, from)
    gap = previous.gap
    const savedUntil = previous.lastSyncedAt.slice(0, 10)
    if (from > savedUntil) {
      // The bank couldn't go back far enough to join up with what's saved: a hole in between.
      gap = mergeGaps(gap, { from: savedUntil, to: from })
    } else if (gap && from < gap.to) {
      // This fetch reaches back into the hole: it's filled, completely or from `from` on.
      gap = from <= gap.from ? null : { from: gap.from, to: from }
    }
  }
  gap = mergeGaps(gap, options.unchecked)

  // Pruning drops everything before keepFrom, including any hole there.
  if (gap && gap.to <= options.keepFrom) gap = null
  else if (gap && gap.from < options.keepFrom) gap = { from: options.keepFrom, to: gap.to }
  return { coveredFrom: laterDate(coveredFrom, options.keepFrom), gap }
}

export const transactionStore = {
  getSync(accountKey: string): AccountSync | null {
    const row = db
      .prepare(
        `SELECT covered_from, gap_from, gap_to, last_synced_at, truncated, last_error, last_failed_at
         FROM account_syncs WHERE account_key = ?`,
      )
      .get(accountKey) as
      | {
          covered_from: string
          gap_from: string | null
          gap_to: string | null
          last_synced_at: string
          truncated: number
          last_error: string | null
          last_failed_at: string | null
        }
      | undefined
    if (!row) return null
    return {
      coveredFrom: row.covered_from,
      gap: row.gap_from && row.gap_to ? { from: row.gap_from, to: row.gap_to } : null,
      lastSyncedAt: row.last_synced_at,
      truncated: row.truncated === 1,
      lastError: row.last_error,
      lastFailedAt: row.last_failed_at,
    }
  },

  // The date of the oldest saved pending (or otherwise unsettled) transaction, if any. A sync
  // starts no later than this, so the bank's answer settles it: still pending, booked or gone.
  oldestUnsettled(accountKey: string): string | null {
    const row = db
      .prepare(
        `SELECT MIN(date) AS oldest FROM transactions
         WHERE account_key = ? AND status IS NOT NULL AND status != 'BOOK' AND date IS NOT NULL`,
      )
      .get(accountKey) as { oldest: string | null }
    return row.oldest
  },

  // Saves what the bank returned for `from` to today, given the account's sync record before it.
  //
  // Not every bank gives transactions a stable id, and pending entries change when booked, so
  // rather than matching transactions one by one this replaces every dated row in that range with
  // the fresh copy. Older rows are left alone: that's the history the bank may no longer return.
  // Fresh entries also replace saved ones with the same entry_reference (unique and unchanging per
  // account, per Enable Banking), even if the date has moved, and exact copies of themselves.
  //
  // Undated rows can't be placed in a range, so they're only ever replaced by reference or copy.
  // And if paging stopped early (`truncated`), the fetch is missing part of its range, so nothing
  // is replaced by range at all.
  save(
    accountKey: string,
    previous: AccountSync | null,
    from: string,
    transactions: StoredTransaction[],
    options: SaveOptions,
  ): AccountSync {
    const now = new Date().toISOString()
    const sync: AccountSync = {
      ...coverageAfter(previous, from, options),
      lastSyncedAt: now,
      truncated: options.truncated,
      lastError: null,
      lastFailedAt: null,
    }

    db.exec('BEGIN')
    try {
      if (!options.truncated) {
        db.prepare('DELETE FROM transactions WHERE account_key = ? AND date >= ?').run(accountKey, from)
      }
      db.prepare(
        `DELETE FROM transactions WHERE account_key = ? AND (
           date < ?
           OR (date IS NULL AND saved_at < ?)
           OR (status IS NOT NULL AND status != 'BOOK' AND date < ?)
         )`,
      ).run(accountKey, options.keepFrom, options.keepFrom, options.dropUnsettledBefore)

      // All deletes before any insert, so two fresh entries that match each other both stay.
      const rows = transactions.map((transaction) => {
        const json = JSON.stringify(transaction)
        return { transaction, json, fingerprint: fingerprint(json) }
      })
      const deleteByReference = db.prepare('DELETE FROM transactions WHERE account_key = ? AND entry_reference = ?')
      const deleteCopies = db.prepare('DELETE FROM transactions WHERE account_key = ? AND fingerprint = ?')
      for (const row of rows) {
        if (row.transaction.entry_reference) deleteByReference.run(accountKey, row.transaction.entry_reference)
        deleteCopies.run(accountKey, row.fingerprint)
      }
      const insert = db.prepare(
        `INSERT INTO transactions (account_key, date, status, entry_reference, fingerprint, saved_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const row of rows) {
        insert.run(
          accountKey,
          dateOf(row.transaction),
          row.transaction.status ?? null,
          row.transaction.entry_reference ?? null,
          row.fingerprint,
          now,
          row.json,
        )
      }

      db.prepare(
        `INSERT INTO account_syncs
           (account_key, covered_from, gap_from, gap_to, last_synced_at, truncated, last_error, last_failed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT (account_key) DO UPDATE SET
           covered_from = excluded.covered_from,
           gap_from = excluded.gap_from,
           gap_to = excluded.gap_to,
           last_synced_at = excluded.last_synced_at,
           truncated = excluded.truncated,
           last_error = NULL,
           last_failed_at = NULL`,
      ).run(
        accountKey,
        sync.coveredFrom,
        sync.gap?.from ?? null,
        sync.gap?.to ?? null,
        sync.lastSyncedAt,
        sync.truncated ? 1 : 0,
      )
      db.exec('COMMIT')
      return sync
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },

  // Remembers that a sync failed, so the bank isn't asked again on every request while it's down.
  recordFailure(accountKey: string, message: string): void {
    db.prepare('UPDATE account_syncs SET last_error = ?, last_failed_at = ? WHERE account_key = ?').run(
      message,
      new Date().toISOString(),
      accountKey,
    )
  },

  // Transactions dated `since` or later, plus undated ones, in the order they were saved.
  list(accountKey: string, since: string): StoredTransaction[] {
    const rows = db
      .prepare('SELECT data FROM transactions WHERE account_key = ? AND (date >= ? OR date IS NULL) ORDER BY rowid')
      .all(accountKey, since) as { data: string }[]
    return rows.map((row) => JSON.parse(row.data) as StoredTransaction)
  },
}
