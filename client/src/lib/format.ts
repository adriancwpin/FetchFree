// Lower-case with accents removed, for matching text: "sparkasse" finds "Sparkasse",
// "ostgota" finds "Östgöta", "lapsilisa" matches "Lapsilisä".
export function normalise(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

// "2026-10" → "Oct", or "October 2026" with style "long".
export function monthLabel(month: string, style: 'short' | 'long' = 'short'): string {
  const [year, monthIndex] = month.split('-').map(Number)
  return new Date(year ?? 0, (monthIndex ?? 1) - 1, 1).toLocaleString(undefined, {
    month: style,
    ...(style === 'long' ? { year: 'numeric' } : {}),
  })
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
