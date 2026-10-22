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
