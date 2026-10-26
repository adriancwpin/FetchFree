// Lower-case with accents removed, for matching text: "sparkasse" finds "Sparkasse",
// "ostgota" finds "Östgöta", "lapsilisa" matches "Lapsilisä".
export function normalise(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

// "2026-10-03" as that day in the user's own calendar (local midnight), not as UTC midnight, which
// would show as the day before for anyone west of UTC.
export function calendarDate(date: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

// "2026-10-03" → "3 Oct 2026" (in the user's locale).
export function longDate(date: string): string {
  return calendarDate(date).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

// "2026-10" → "Oct", or "October 2026" with style "long".
export function monthLabel(month: string, style: 'short' | 'long' = 'short'): string {
  const [year, monthIndex] = month.split('-').map(Number)
  return new Date(year ?? 0, (monthIndex ?? 1) - 1, 1).toLocaleString(undefined, {
    month: style,
    ...(style === 'long' ? { year: 'numeric' } : {}),
  })
}

// Relative times go inside the app's English sentences ("Updated 3 minutes ago", "expires in 2
// days"), so they're in English too; a browser locale would give "expires 2 päivän päästä". Dates
// and amounts stay in the user's own format.
const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

// Milliseconds from `now` until an ISO time (negative once it has passed), or null if unreadable.
export function msUntil(iso: string, now: Date = new Date()): number | null {
  const ms = new Date(iso).getTime() - now.getTime()
  return Number.isNaN(ms) ? null : ms
}

// "just now", "3 minutes ago", "yesterday"… for an ISO time in the past. An unreadable one is
// shown as it is.
export function timeAgo(iso: string, now: Date = new Date()): string {
  const ms = msUntil(iso, now)
  if (ms === null) return iso
  const seconds = Math.round(ms / 1000)
  if (seconds > -60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes > -60) return relativeTime.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours > -24) return relativeTime.format(hours, 'hour')
  return relativeTime.format(Math.round(hours / 24), 'day')
}

// Always "in 1 day", never "tomorrow": 30 hours from now may be the day after tomorrow. English for
// the same reason as relativeTime.
const countdown = new Intl.RelativeTimeFormat('en', { numeric: 'always' })

// "in 2 days", "in 5 hours", "in 12 minutes" for `msLeft` milliseconds. Rounded down, so it never
// promises more time than is left. Under a minute (or none left) it's "this minute".
export function timeLeft(msLeft: number): string {
  const minutes = Math.floor(msLeft / 60_000)
  if (minutes < 1) return relativeTime.format(0, 'minute')
  if (minutes < 60) return countdown.format(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return countdown.format(hours, 'hour')
  return countdown.format(Math.floor(hours / 24), 'day')
}

// "4 Nov 2026, 17:53" (in the user's locale), or null if unreadable.
export function dateTime(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const regionNames = new Intl.DisplayNames(undefined, { type: 'region' })

// "FI" → "Finland". Intl throws on a malformed code, so fall back to the code itself.
export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

// Formats the amount without its sign (the caller shows direction). Unparseable amounts are
// passed through unchanged so formatAmount can show the raw text.
export function formatUnsignedAmount(amount: string, currency: string): string {
  const value = Number(amount)
  return formatAmount(Number.isNaN(value) ? amount : String(Math.abs(value)), currency)
}

export function formatAmount(amount: string, currency: string): string {
  const value = Number(amount)
  if (Number.isNaN(value)) return `${amount} ${currency}`
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value)
  } catch {
    // Unknown ISO currency code.
    return `${value.toFixed(2)} ${currency}`
  }
}
