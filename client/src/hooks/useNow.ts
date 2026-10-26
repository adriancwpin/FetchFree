import { useEffect, useState } from 'react'

// The current time, updated so text like "3 minutes ago" or "expires in 2 hours" keeps up while the
// page is open. `next` is how long after the time shown the following update is due: a fixed
// number of ms, or worked out from that time (e.g. so it lands exactly when a countdown changes).
//
// The update is aimed at that moment, not "that long from now", so a re-render that changes `next`
// (e.g. new data) never pushes it back, and if the moment has already passed it happens straight
// away. `recheckOn` re-checks that whenever it changes: pass something that changes when new data
// arrives (e.g. after the computer slept, when timers may have been paused), so the time shown is
// never stale for longer than it takes to notice.
export function useNow(next: number | ((now: Date) => number), recheckOn?: unknown): Date {
  const [now, setNow] = useState(() => new Date())
  const dueAt = now.getTime() + (typeof next === 'number' ? next : next(now))

  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), Math.max(0, dueAt - Date.now()))
    return () => clearTimeout(timer)
  }, [now, dueAt, recheckOn])

  return now
}
