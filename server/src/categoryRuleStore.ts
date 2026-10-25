import { db } from './db.js'

export type Direction = 'in' | 'out'

// "Everything from this payee is in this category", set by the user. Rules are per payee rather
// than per transaction because saved transactions are rewritten on every sync and some banks send
// no stable id, so an edit to one transaction wouldn't survive.
export interface CategoryRule {
  direction: Direction
  // The client's matching key for the payee (normalised text). The server only stores it.
  payee: string
  category: string
}

// Filed under the stable account key like budgets, so rules survive reconnecting the bank. As with
// budgets, the server doesn't know the category list; the client ignores ids it doesn't recognise.
export const categoryRuleStore = {
  list(accountKey: string): CategoryRule[] {
    return db
      .prepare(
        'SELECT direction, payee, category FROM category_rules WHERE account_key = ? ORDER BY direction, payee',
      )
      .all(accountKey) as unknown as CategoryRule[]
  },

  set(accountKey: string, rule: CategoryRule): CategoryRule {
    db.prepare(
      `INSERT INTO category_rules (account_key, direction, payee, category) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_key, direction, payee) DO UPDATE SET category = excluded.category`,
    ).run(accountKey, rule.direction, rule.payee, rule.category)
    return rule
  },

  remove(accountKey: string, direction: Direction, payee: string): void {
    db.prepare('DELETE FROM category_rules WHERE account_key = ? AND direction = ? AND payee = ?').run(
      accountKey,
      direction,
      payee,
    )
  },
}
