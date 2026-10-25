import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

// All SQL lives here and in the stores (sessionStore.ts, transactionStore.ts, budgetStore.ts), so
// moving to Postgres later only touches these files.

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
    aspsp_country TEXT
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
`)

// CREATE TABLE IF NOT EXISTS leaves tables from older versions unchanged, so add any columns
// they're missing. Existing rows get NULL, which the code treats as "bank unknown".
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
