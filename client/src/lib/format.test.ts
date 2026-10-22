import { describe, expect, it } from 'vitest'
import { countryName, formatAmount, formatUnsignedAmount } from '@/lib/format'

describe('formatUnsignedAmount', () => {
  it('drops the sign, since the caller shows direction separately', () => {
    expect(formatUnsignedAmount('-12.5', 'EUR')).toBe(formatAmount('12.5', 'EUR'))
  })

  it("passes an amount that isn't a number through as raw text instead of showing NaN", () => {
    expect(formatUnsignedAmount('1.234,50', 'EUR')).toBe('1.234,50 EUR')
  })
})

describe('formatAmount', () => {
  it('falls back to a plain number for an unknown currency code', () => {
    expect(formatAmount('5', 'NOT-A-CURRENCY')).toBe('5.00 NOT-A-CURRENCY')
  })
})

describe('countryName', () => {
  it('turns a country code into a name', () => {
    expect(countryName('FI')).not.toBe('FI')
  })

  it('returns the code itself instead of crashing on a malformed one', () => {
    expect(countryName('not a code')).toBe('not a code')
  })
})
