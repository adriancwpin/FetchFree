import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

// All SQL lives here and in sessionStore.ts, so moving to Postgres later only touches these two files.

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
