import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'

let dir: string | undefined

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  process.env.DB_PATH = ':memory:'
})

it('adds the newer columns to a database from an older version without losing the session', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchfree-migration-'))
  const dbPath = path.join(dir, 'legacy.db')

  // The schema as it was before the bank picker, with a live connection in it.
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE pending_auths (state TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE bank_sessions (session_id TEXT PRIMARY KEY, accounts TEXT NOT NULL,
                                valid_until TEXT NOT NULL, created_at TEXT NOT NULL);
  `)
  legacy
    .prepare('INSERT INTO bank_sessions VALUES (?, ?, ?, ?)')
    .run('legacy-session', '[{"uid":"acc-1"}]', '2099-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
  legacy.close()

  // Load the app's database code against that file; importing db.ts runs the migration.
  process.env.DB_PATH = dbPath
  vi.resetModules()
  const { sessionStore } = await import('./sessionStore.js')
  const { db } = await import('./db.js')

  const columnsOf = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  for (const table of ['pending_auths', 'bank_sessions']) {
    expect(columnsOf(table)).toEqual(expect.arrayContaining(['aspsp_name', 'aspsp_country']))
  }
  expect(columnsOf('bank_sessions')).toContain('ended_reason')
  expect(sessionStore.getCurrentSession()).toMatchObject({ sessionId: 'legacy-session', bank: null })
  expect(sessionStore.getLatestSession()?.ended).toBeNull()
  db.close()
})
