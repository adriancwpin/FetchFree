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
