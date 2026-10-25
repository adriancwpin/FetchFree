import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBank, json } from '../test/fakeBank.js'
import { db } from './db.js'
import { EnableBankingError } from './enableBankingClient.js'
import { confirmEnded, SessionEndedError } from './sessionEnded.js'
import { sessionStore } from './sessionStore.js'

const REFUSED = new EnableBankingError(401, { message: 'refused' })

beforeEach(() => {
  db.exec('DELETE FROM bank_sessions;')
  sessionStore.setCurrentSession({
    sessionId: 's1',
    accounts: [],
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    bank: null,
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('confirmEnded', () => {
  it('shares one status check between refusals that arrive before it answers', async () => {
    let answer!: () => void
    const answered = new Promise<void>((resolve) => (answer = resolve))
    const calls = fakeBank(async () => {
      await answered
      return json({ status: 'REVOKED' })
    })

    // All three start before Enable Banking has answered the first check.
    const results = [confirmEnded('s1', REFUSED), confirmEnded('s1', REFUSED), confirmEnded('s1', REFUSED)].map(
      (result) => result.catch((err: unknown) => err),
    )
    answer()

    for (const error of await Promise.all(results)) expect(error).toBeInstanceOf(SessionEndedError)
    expect(calls).toHaveLength(1)
    expect(sessionStore.getLatestSession()?.ended).toBe('revoked')
  })

  it('asks again for a refusal after the previous check has answered', async () => {
    const calls = fakeBank(() => json({ status: 'AUTHORIZED' }))

    await expect(confirmEnded('s1', REFUSED)).rejects.toBe(REFUSED)
    await expect(confirmEnded('s1', REFUSED)).rejects.toBe(REFUSED)
    expect(calls).toHaveLength(2)
  })

  it.each([
    ['a 429 (rate limit)', new EnableBankingError(429, {})],
    ['a 5xx', new EnableBankingError(503, {})],
    ['something that is not a bank error', new Error('bug')],
  ])("doesn't check the session for %s", async (_case, error) => {
    const calls = fakeBank(() => json({ status: 'REVOKED' }))

    await expect(confirmEnded('s1', error)).rejects.toBe(error)
    expect(calls).toHaveLength(0)
  })
})
