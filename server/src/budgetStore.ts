import { db } from './db.js'

// A monthly spending limit for one category, the same every month. Amounts are stored in whole
// cents, like all money maths in the app, and returned in units (e.g. 300.5 for €300.50).
export interface Budget {
  category: string
  amount: number
}

// Filed under the stable account key (see transactionSync.ts accountKey), so budgets survive
// reconnecting the bank. The server doesn't know the category list; the client ignores ids it
// doesn't recognise.
export const budgetStore = {
  list(accountKey: string): Budget[] {
    const rows = db
      .prepare('SELECT category, amount_cents FROM budgets WHERE account_key = ? ORDER BY category')
      .all(accountKey) as { category: string; amount_cents: number }[]
    return rows.map((row) => ({ category: row.category, amount: row.amount_cents / 100 }))
  },

  set(accountKey: string, category: string, cents: number): Budget {
    db.prepare(
      `INSERT INTO budgets (account_key, category, amount_cents) VALUES (?, ?, ?)
       ON CONFLICT (account_key, category) DO UPDATE SET amount_cents = excluded.amount_cents`,
    ).run(accountKey, category, cents)
    return { category, amount: cents / 100 }
  },

  remove(accountKey: string, category: string): void {
    db.prepare('DELETE FROM budgets WHERE account_key = ? AND category = ?').run(accountKey, category)
  },
}
