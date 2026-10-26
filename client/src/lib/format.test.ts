import { describe, expect, it } from 'vitest'
import {
  calendarDate,
  countryName,
  dateTime,
  formatAmount,
  formatUnsignedAmount,
  msUntil,
  timeAgo,
  timeLeft,
} from '@/lib/format'

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

describe('timeAgo', () => {
  const now = new Date('2026-10-25T12:00:00.000Z')
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString()

  it.each([
    // In English whatever the browser's language, like the sentences it goes into.
    [before(20_000), 'just now'],
    [before(3 * 60_000), '3 minutes ago'],
    [before(2 * 3_600_000), '2 hours ago'],
    [before(3 * 86_400_000), '3 days ago'],
  ])('describes %s relative to now', (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected)
  })

  it('passes an unreadable time through instead of showing NaN', () => {
    expect(timeAgo('not a time', now)).toBe('not a time')
  })
})

describe('msUntil', () => {
  const now = new Date('2026-10-25T12:00:00.000Z')

  it('is the time left, negative once passed, and null for an unreadable time', () => {
    expect(msUntil('2026-10-25T12:01:00.000Z', now)).toBe(60_000)
    expect(msUntil('2026-10-25T11:59:00.000Z', now)).toBe(-60_000)
    expect(msUntil('not a time', now)).toBeNull()
  })
})

describe('timeLeft', () => {
  it.each([
    [12 * 60_000, 'in 12 minutes'],
    [5 * 3_600_000, 'in 5 hours'],
    [2 * 86_400_000, 'in 2 days'],
    // Rounded down, never promising more time than is left: 47h59m is 1 day, 59m59s is 59 minutes.
    [2 * 86_400_000 - 60_000, 'in 1 day'],
    [3_600_000 - 1000, 'in 59 minutes'],
    // Always a number, never "tomorrow": 30 hours from now may be the day after tomorrow.
    [30 * 3_600_000, 'in 1 day'],
    // Under a minute, or none left.
    [59_000, 'this minute'],
    [0, 'this minute'],
    [-5000, 'this minute'],
  ])('describes %i ms left, in English', (msLeft, expected) => {
    expect(timeLeft(msLeft)).toBe(expected)
  })
})

describe('dateTime', () => {
  it('formats a readable time with its date, and gives null for an unreadable one', () => {
    expect(dateTime('2026-11-04T17:53:00.000Z')).toBe(
      new Date('2026-11-04T17:53:00.000Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    )
    expect(dateTime('not a time')).toBeNull()
  })
})

describe('calendarDate', () => {
  it("reads a date as that day in the user's own calendar, whatever their timezone", () => {
    const date = calendarDate('2026-10-03')
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 9, 3])
  })
})
