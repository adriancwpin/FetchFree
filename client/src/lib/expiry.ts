// When the app warns that the bank connection is about to expire, when it asks the server whether it
// has, and when the connection bar needs to re-render for either. All times are by the server's
// clock (api.ts serverClock), which decides when valid_until has passed; `msLeft` is the time until
// valid_until, negative once it has.

// How long before valid_until the warning starts. A whole number of minutes, which msUntilNextTick
// relies on.
export const EXPIRY_WARNING_MS = 2 * 24 * 3_600_000

// True with EXPIRY_WARNING_MS or less left, including none: the warning stays until the server
// reports the connection as ended (moments later), rather than flicking back to "Connected".
export function expiresSoon(msLeft: number): boolean {
  return msLeft <= EXPIRY_WARNING_MS
}

// The first check comes a second after valid_until (until then the server says connected anyway).
// If the server still says connected (the clock offset is measured, not exact) or the check fails,
// it's asked again every 30 seconds for 5 minutes, then every 5 minutes for as long as the page is
// open, so it's never left stuck.
const CHECK_AFTER_EXPIRY_MS = 1000
const EARLY_RECHECK_MS = 30_000
const EARLY_RECHECK_FOR_MS = 5 * 60_000
const LATE_RECHECK_MS = 5 * 60_000

// How long until /status should be asked (0: now), or null if there's no readable valid_until.
// `sinceLastCheckMs` is how long ago it last answered or failed (Infinity if never).
export function msUntilStatusCheck({
  msLeft,
  sinceLastCheckMs,
}: {
  msLeft: number | null
  sinceLastCheckMs: number
}): number | null {
  if (msLeft === null) return null
  const untilFirst = msLeft + CHECK_AFTER_EXPIRY_MS
  if (untilFirst > 0) return untilFirst
  const pastMs = -msLeft
  // The last check came before the first one was due, so it couldn't have seen the expiry.
  if (sinceLastCheckMs > pastMs - CHECK_AFTER_EXPIRY_MS) return 0
  // Otherwise the next recheck: every 30 seconds while that's within the first 5 minutes, then
  // every 5 minutes.
  const early = Math.max(0, EARLY_RECHECK_MS - sinceLastCheckMs)
  if (pastMs + early <= EARLY_RECHECK_FOR_MS) return early
  return Math.max(0, LATE_RECHECK_MS - sinceLastCheckMs)
}

export function statusCheckDue(times: { msLeft: number | null; sinceLastCheckMs: number }): boolean {
  return msUntilStatusCheck(times) === 0
}

// Just past each moment, so what's due has happened by then.
const TICK_MARGIN_MS = 50
// At least this often, so a tick re-reads the clock soon after the computer wakes from sleep.
const MAX_TICK_MS = 60_000

// When the connection bar next needs to re-render: when what it shows changes, or a check with the
// server falls due, whichever is first. What it shows changes only when the time left crosses a
// whole minute: the countdown ("in 12 minutes", rounded down), the start of the warning (a whole
// number of minutes before) and the expiry itself. A check that's due now isn't waited for: it's
// being made, and its answer re-renders the bar anyway.
export function msUntilNextTick(times: { msLeft: number | null; sinceLastCheckMs: number }): number {
  const { msLeft } = times
  const display = msLeft !== null && msLeft > 0 ? (msLeft % 60_000 || 60_000) + TICK_MARGIN_MS : Infinity
  const check = msUntilStatusCheck(times)
  const checkTick = check !== null && check > 0 ? check + TICK_MARGIN_MS : Infinity
  return Math.min(display, checkTick, MAX_TICK_MS)
}
