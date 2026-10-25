import {
  ArrowLeftRight,
  Banknote,
  Briefcase,
  Car,
  CircleHelp,
  Clapperboard,
  Dices,
  Gift,
  HandCoins,
  HeartPulse,
  House,
  Landmark,
  Plane,
  Receipt,
  ShoppingBag,
  ShoppingCart,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'
import type { Transaction } from '@/lib/api'
import { normalise } from '@/lib/format'
import { type CountedTransactions, dateOf, directionOf, toCents } from '@/lib/summary'

// Banks rarely send a category (Nordea's merchant_category_code is always empty), so each
// transaction is categorised from its text: who was paid, the payment message and the bank's own
// transaction type. Rules are matched in order; the first match wins, so specific rules come first.

export type Direction = 'in' | 'out'

export const CATEGORIES = {
  // Money out
  groceries: { label: 'Groceries', icon: ShoppingCart, direction: 'out' },
  eatingOut: { label: 'Eating out', icon: UtensilsCrossed, direction: 'out' },
  shopping: { label: 'Shopping', icon: ShoppingBag, direction: 'out' },
  transport: { label: 'Transport', icon: Car, direction: 'out' },
  travel: { label: 'Travel', icon: Plane, direction: 'out' },
  bills: { label: 'Bills & utilities', icon: Receipt, direction: 'out' },
  housing: { label: 'Housing', icon: House, direction: 'out' },
  health: { label: 'Health & fitness', icon: HeartPulse, direction: 'out' },
  entertainment: { label: 'Entertainment', icon: Clapperboard, direction: 'out' },
  cash: { label: 'Cash', icon: Banknote, direction: 'out' },
  gifts: { label: 'Gifts & charity', icon: Gift, direction: 'out' },
  gambling: { label: 'Gambling', icon: Dices, direction: 'out' },
  transfersOut: { label: 'Transfers between accounts', icon: ArrowLeftRight, direction: 'out' },
  toPeople: { label: 'Payments to people', icon: Users, direction: 'out' },
  otherOut: { label: 'Other', icon: CircleHelp, direction: 'out' },
  // Money in
  salary: { label: 'Salary', icon: Briefcase, direction: 'in' },
  benefits: { label: 'Benefits', icon: Landmark, direction: 'in' },
  transfersIn: { label: 'Transfers between accounts', icon: ArrowLeftRight, direction: 'in' },
  fromPeople: { label: 'From people', icon: HandCoins, direction: 'in' },
  otherIn: { label: 'Other income', icon: CircleHelp, direction: 'in' },
} as const satisfies Record<string, { label: string; icon: LucideIcon; direction: Direction }>

export type CategoryId = keyof typeof CATEGORIES

interface Rule {
  category: CategoryId
  // Matched against normalised text: lower case, accents removed ("Lapsilisä" → "lapsilisa").
  // Whole words only (\b…\b) unless a prefix is intended, so "steam" doesn't match "Steamboat".
  match: RegExp
}

// Money-out rules, in priority order. Finnish and English, since the test bank is Finnish.
//   1. What the bank itself says the transaction is (own transfer, ATM): the most reliable.
//   2. Named merchants and specific kinds of business.
//   3. Generic words that could also appear in a merchant's name ("internet", "rent") come last,
//      so "Internet Pizza Oy" is eating out, not a bill.
const OUT_RULES: Rule[] = [
  { category: 'transfersOut', match: /\boma siirto\b|\bown transfer\b|\bsiirto omalle\b/ },
  { category: 'cash', match: /\batm\b|\bnosto\b|automaattiotto|cash withdrawal/ },
  { category: 'gambling', match: /\blotto\b|\bveikkaus\b|\bcasino\b|\bbet(ting)?\b/ },
  {
    category: 'groceries',
    match:
      /\bk[- ]?(market|citymarket|supermarket)\b|\bs[- ]?market\b|\bprisma\b|\blidl\b|\balepa\b|\bwall?mart\b|\btesco\b|\baldi\b|\bgrocer|\bsupermarket\b/,
  },
  {
    category: 'eatingOut',
    match: /\brestaurant|\bravintola|\bcafe\b|\bkahvila|\bmcdonald|\bburger|\bpizz|\bsushi\b|\bwolt\b|\bfoodora\b/,
  },
  // Before travel: a car hire or taxi at an airport is still transport.
  // VR is the Finnish rail operator, Neste a fuel chain.
  {
    category: 'transport',
    match: /\bavis\b|\bhertz\b|\buber\b|\bbolt\b|\btaxi\b|\btaksi\b|\bhsl\b|\bvr\b|\bneste\b|\bfuel\b|\bparking\b|\bpysakointi\b/,
  },
  {
    category: 'travel',
    match: /\bairport\b|\blentoasema\b|\bheathrow\b|\bkastrup\b|\bhotel|\bairbnb\b|\bfinnair\b|booking\.com|\bheinemann\b|\bduty free\b/,
  },
  {
    category: 'entertainment',
    match: /\bkino\b|\bcinema\b|\belokuva|\bfinnkino\b|\bnetflix\b|\bspotify\b|\bsteam\b|\bplaystation\b|\bconcert|\bticketmaster\b/,
  },
  {
    category: 'health',
    match: /\bsports? club\b|\bgym\b|\bkuntosali\b|\bapteekki\b|\bpharmacy\b|\bterveystalo\b|\bmehilainen\b|\bdoctor\b|\blaakari\b/,
  },
  {
    category: 'shopping',
    match: /\bamazon\b|\bzalando\b|\bh&m\b|\bikea\b|\bstockmann\b|\bgigantti\b|\bverkkokauppa\b|\bclothing\b/,
  },
  // Charities by their own words; not every Finnish association ("ry") is a charity.
  {
    category: 'gifts',
    match: /\blahja|\bpresents?\b|\bgifts?\b|missio|\bmission\b|\bcharity\b|\bdonation|\blahjoitus|\bred cross\b/,
  },
  // DNA, Elisa and Telia are Finnish phone and internet operators.
  {
    category: 'bills',
    match:
      /\bmobile phone\b|\bpuhelin|\belisa\b|\btelia\b|\bdna\b|\belectricity\b|\bsahko|\bfortum\b|\binternet\b|\bbroadband\b|\binsurance\b|\bvakuutus/,
  },
  { category: 'housing', match: /\brent\b|\bvuokra|\bap+artments?\b|\bmortgage\b|\basuntolaina\b/ },
]

// Money-in rules, in priority order.
const IN_RULES: Rule[] = [
  { category: 'transfersIn', match: /\boma siirto\b|\bown transfer\b|\bsiirto omalle\b/ },
  { category: 'benefits', match: /\bkela\b|\bfpa\b|\blapsilisa\b|\bchild benefit\b|\belake|\bpension\b|\btyottomyys/ },
  { category: 'salary', match: /\bpalkka|\bsalary\b|\bpayroll\b|\bwages?\b/ },
]

// Exposed for tests: they check each rule's category belongs to the direction it's listed under.
export const RULES: Record<Direction, readonly Rule[]> = { out: OUT_RULES, in: IN_RULES }

// Card purchases that match no rule are most likely shopping.
const CARD_PURCHASE = /korttiosto|card purchase|\bpos\b/

// Words that mark a counterparty as a business rather than a person.
const BUSINESS_WORDS =
  /\b(oy|oyj|ab|ltd|limited|inc|gmbh|ry|plc|club|market|store|shop|retail|bank|apartments?|appartments?|services?|group|company|co)\b/

// "Salo Johanna" or "Simon Baker": two or three capitalised words, no digits, no business words.
function looksLikePerson(name: string | null | undefined): boolean {
  if (!name) return false
  const words = name.trim().split(/\s+/)
  if (words.length < 2 || words.length > 3) return false
  if (BUSINESS_WORDS.test(normalise(name))) return false
  return words.every((word) => /^\p{Lu}[\p{L}'-]+$/u.test(word))
}

function counterpartyOf(transaction: Transaction, direction: Direction): string | null {
  return (direction === 'out' ? transaction.creditor?.name : transaction.debtor?.name) ?? null
}

// All the text the rules look at, normalised.
function searchText(transaction: Transaction, direction: Direction): string {
  return normalise(
    [
      counterpartyOf(transaction, direction),
      ...(transaction.remittance_information ?? []),
      transaction.bank_transaction_code?.description,
    ]
      .filter(Boolean)
      .join(' '),
  )
}

function computeCategory(transaction: Transaction): CategoryId {
  // Zero or unknown direction: treat as money out, which is where most such entries belong.
  const direction: Direction = directionOf(transaction) ?? 'out'
  const text = searchText(transaction, direction)

  const rule = RULES[direction].find(({ match }) => match.test(text))
  if (rule) return rule.category

  const counterparty = counterpartyOf(transaction, direction)
  if (direction === 'in') return looksLikePerson(counterparty) ? 'fromPeople' : 'otherIn'
  if (CARD_PURCHASE.test(text)) return 'shopping'
  return looksLikePerson(counterparty) ? 'toPeople' : 'otherOut'
}

// The table, the breakdown and its filter all ask for the same transaction's category, often on
// every render. Transactions are immutable objects from the query cache, so remember the answer
// per object; entries disappear with the objects when the data is refetched.
const categoryCache = new WeakMap<Transaction, CategoryId>()

export function categorize(transaction: Transaction): CategoryId {
  let category = categoryCache.get(transaction)
  if (category === undefined) {
    category = computeCategory(transaction)
    categoryCache.set(transaction, category)
  }
  return category
}

export interface CategorySelection {
  direction: Direction
  // YYYY-MM for one month; undefined for the whole window.
  month?: string
  // One category; undefined for all of them.
  category?: CategoryId
}

// The counted transactions for one direction, optionally narrowed to a month and a category.
// The breakdown totals these and the filtered table lists them, so a category's rows always add up
// to the amount shown for it.
export function transactionsFor(counted: CountedTransactions, selection: CategorySelection): Transaction[] {
  return counted.transactions.filter(
    (transaction) =>
      directionOf(transaction) === selection.direction &&
      (!selection.month || (dateOf(transaction) ?? '').startsWith(selection.month)) &&
      (!selection.category || categorize(transaction) === selection.category),
  )
}

export interface CategoryTotal {
  category: CategoryId
  amount: number
  count: number
  // Fraction of the direction's total, 0–1.
  share: number
}

// Totals per category for one direction, largest first. Built from the same counted transactions
// as the monthly summary, so the amounts add up to its "Money in"/"Money out".
export function breakdownByCategory(
  counted: CountedTransactions,
  direction: Direction,
  month?: string,
): CategoryTotal[] {
  const totals = new Map<CategoryId, { cents: number; count: number }>()
  let totalCents = 0

  for (const transaction of transactionsFor(counted, { direction, month })) {
    const cents = toCents(transaction.transaction_amount.amount)
    const category = categorize(transaction)
    const entry = totals.get(category) ?? { cents: 0, count: 0 }
    entry.cents += cents
    entry.count++
    totals.set(category, entry)
    totalCents += cents
  }

  return [...totals.entries()]
    .map(([category, { cents, count }]) => ({
      category,
      amount: cents / 100,
      count,
      share: totalCents === 0 ? 0 : cents / totalCents,
    }))
    .sort((a, b) => b.amount - a.amount || CATEGORIES[a.category].label.localeCompare(CATEGORIES[b.category].label))
}
