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
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bank_sessions (
    session_id TEXT PRIMARY KEY,
    accounts TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`)
