import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

// All SQL lives here and in the stores (sessionStore.ts, transactionStore.ts, budgetStore.ts,
// categoryRuleStore.ts), so moving to Postgres later only touches these files.

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })

export const db = new DatabaseSync(config.dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_auths (
    state TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    aspsp_name TEXT,
    aspsp_country TEXT
  );

  CREATE TABLE IF NOT EXISTS bank_sessions (
    session_id TEXT PRIMARY KEY,
    accounts TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    created_at TEXT NOT NULL,
    aspsp_name TEXT,
    aspsp_country TEXT,
    -- Set when the bank says the session has ended (see sessionEnded.ts).
    ended_reason TEXT
  );

  -- Saved transactions, kept across reloads and reconnects (see transactionStore.ts).
  CREATE TABLE IF NOT EXISTS transactions (
    account_key TEXT NOT NULL,
    date TEXT,
    status TEXT,
    entry_reference TEXT,
    fingerprint TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transactions_account_date ON transactions (account_key, date);
  CREATE INDEX IF NOT EXISTS transactions_account_reference ON transactions (account_key, entry_reference);
  CREATE INDEX IF NOT EXISTS transactions_account_fingerprint ON transactions (account_key, fingerprint);

  CREATE TABLE IF NOT EXISTS account_syncs (
    account_key TEXT PRIMARY KEY,
    covered_from TEXT NOT NULL,
    gap_from TEXT,
    gap_to TEXT,
    last_synced_at TEXT NOT NULL,
    truncated INTEGER NOT NULL,
    last_error TEXT,
    last_failed_at TEXT
  );

  -- Monthly spending limits per category (see budgetStore.ts).
  CREATE TABLE IF NOT EXISTS budgets (
    account_key TEXT NOT NULL,
    category TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    PRIMARY KEY (account_key, category)
  );

  -- The user's own category for everything from one payee (see categoryRuleStore.ts).
  CREATE TABLE IF NOT EXISTS category_rules (
    account_key TEXT NOT NULL,
    direction TEXT NOT NULL,
    payee TEXT NOT NULL,
    category TEXT NOT NULL,
    PRIMARY KEY (account_key, direction, payee)
  );
`)

// CREATE TABLE IF NOT EXISTS leaves tables from older versions unchanged, so add any columns
// they're missing. Existing rows get NULL, which the code treats as "bank unknown" or "not ended".
function addColumnIfMissing(table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

for (const table of ['pending_auths', 'bank_sessions']) {
  addColumnIfMissing(table, 'aspsp_name', 'TEXT')
  addColumnIfMissing(table, 'aspsp_country', 'TEXT')
}
addColumnIfMissing('bank_sessions', 'ended_reason', 'TEXT')

// An earlier version also ended sessions on unclear answers from Enable Banking (recorded as
// "ended"). Only expired, revoked and closed count now, so give those sessions another chance: if
// one really has ended, the next refusal from the bank records it properly.
db.exec("UPDATE bank_sessions SET ended_reason = NULL WHERE ended_reason NOT IN ('expired', 'revoked', 'closed')")
