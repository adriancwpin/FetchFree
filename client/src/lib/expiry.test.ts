import { describe, expect, it } from 'vitest'
import { EXPIRY_WARNING_MS, expiresSoon, msUntilNextTick, msUntilStatusCheck, statusCheckDue } from '@/lib/expiry'

describe('expiresSoon', () => {
  it('starts warning exactly EXPIRY_WARNING_MS before, not earlier', () => {
    expect(EXPIRY_WARNING_MS).toBe(2 * 86_400_000)
    expect(expiresSoon(EXPIRY_WARNING_MS)).toBe(true)
    expect(expiresSoon(EXPIRY_WARNING_MS + 1)).toBe(false)
  })

  it('keeps warning once passed, until the server says it has ended', () => {
    expect(expiresSoon(-5000)).toBe(true)
  })
})

describe('statusCheckDue (switching to read-only when the connection expires)', () => {
  // `msLeft` until valid_until (negative: that long ago).
  const due = (msLeft: number | null, sinceLastCheckMs: number) => statusCheckDue({ msLeft, sinceLastCheckMs })

  it('never asks before valid_until, or in the first second after it', () => {
    expect(due(2 * 3_600_000, Infinity)).toBe(false)
    expect(due(-999, Infinity)).toBe(false)
  })

  it('asks a second after valid_until if the last check was before then', () => {
    expect(due(-1000, Infinity)).toBe(true)
    // Checked 10 minutes before valid_until, e.g. on window focus: that couldn't see the expiry.
    expect(due(-1000, 10 * 60_000)).toBe(true)
  })

  it('asks right away after waking from sleep past valid_until, however long ago that was', () => {
    // Slept from an hour before valid_until to an hour after: the last check was 2 hours ago.
    expect(due(-3_600_000, 2 * 3_600_000)).toBe(true)
  })

  it('after a check that still said connected (or failed), asks again every 30 seconds for 5 minutes', () => {
    expect(due(-20_000, 10_000)).toBe(false)
    expect(due(-40_000, 29_999)).toBe(false)
    expect(due(-40_000, 30_000)).toBe(true)
    expect(due(-5 * 60_000, 30_000)).toBe(true)
  })

  it('then every 5 minutes, for as long as the page is open, so it never gets stuck', () => {
    expect(due(-10 * 60_000, 60_000)).toBe(false)
    expect(due(-10 * 60_000, 5 * 60_000)).toBe(true)
    expect(due(-3 * 86_400_000, 5 * 60_000)).toBe(true)
  })

  it('never asks without a readable valid_until', () => {
    expect(due(null, Infinity)).toBe(false)
  })
})

describe('msUntilStatusCheck', () => {
  const until = (msLeft: number | null, sinceLastCheckMs: number) => msUntilStatusCheck({ msLeft, sinceLastCheckMs })

  it('is the time to a second after valid_until before then', () => {
    expect(until(2 * 3_600_000, 0)).toBe(2 * 3_600_000 + 1000)
  })

  it('is the time to the next recheck after a check, 30 seconds then 5 minutes apart', () => {
    // 20 s after valid_until, checked 10 s ago (after the first check was due): 20 s to go.
    expect(until(-20_000, 10_000)).toBe(20_000)
    // 10 minutes after, checked a minute ago: 4 minutes to go.
    expect(until(-10 * 60_000, 60_000)).toBe(4 * 60_000)
    // 4m50s after, checked just now: the next recheck would land past 5 minutes, so it's 5 minutes.
    expect(until(-(4 * 60_000 + 50_000), 0)).toBe(5 * 60_000)
  })

  it('is null without a readable valid_until', () => {
    expect(until(null, 0)).toBeNull()
  })
})

describe('msUntilNextTick (when the connection bar re-renders)', () => {
  const tick = (msLeft: number | null, sinceLastCheckMs = 0) => msUntilNextTick({ msLeft, sinceLastCheckMs })

  it('wakes just after the time left next crosses a whole minute, when what it shows changes', () => {
    // 12 minutes 30 seconds left: "in 12 minutes" becomes "in 11 minutes" in 30 seconds.
    expect(tick(12 * 60_000 + 30_000)).toBe(30_050)
    // 30 seconds before expiry: wakes just after it, to say it has expired.
    expect(tick(30_000)).toBe(30_050)
  })

  it('lands on the start of the warning, which is a whole number of minutes before', () => {
    expect(EXPIRY_WARNING_MS % 60_000).toBe(0)
    expect(tick(EXPIRY_WARNING_MS + 10_000)).toBe(10_050)
  })

  it('wakes at most a minute apart, so the clock is re-read soon after the computer sleeps', () => {
    expect(tick(12 * 60_000)).toBe(60_000)
    expect(tick(null)).toBe(60_000)
    expect(tick(-60 * 60_000, 60_000)).toBe(60_000)
  })

  it('after expiry, wakes just when the next check with the server falls due, not every second', () => {
    // 20 s after valid_until, checked 10 s ago: next check in 20 s.
    expect(tick(-20_000, 10_000)).toBe(20_050)
    // Half a second after valid_until: the first check is due in half a second.
    expect(tick(-500, 60_000)).toBe(550)
  })

  it("doesn't wait for a check that's due now (it's being made, and its answer re-renders)", () => {
    expect(tick(-5000, Infinity)).toBe(60_000)
  })
})
