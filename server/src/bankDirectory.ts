import * as enableBanking from './enableBankingClient.js'

// The bank list rarely changes, so it's cached in memory instead of being fetched for every
// keystroke in the picker or every login.
const CACHE_TTL_MS = 60 * 60 * 1000

interface CacheEntry<T> {
  value: Promise<T>
  expiresAt: number
}

const cache = new Map<string, CacheEntry<unknown>>()

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const entry = cache.get(key) as CacheEntry<T> | undefined
  if (entry && entry.expiresAt > Date.now()) return entry.value

  const value = load()
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  // Don't keep a failure cached: the next call should try again.
  value.catch(() => cache.delete(key))
  return value
}

export function getCountries(): Promise<string[]> {
  return cached('countries', async () => {
    const countries = await enableBanking.listCountries()
    // An empty list means something is wrong upstream; throwing keeps it out of the cache,
    // instead of rejecting every login as "unknown bank" for an hour.
    if (countries.length === 0) throw new Error('Enable Banking returned no supported countries')
    return [...countries].sort()
  })
}

// Mock ASPSP is Enable Banking's test bank; list it after the real ones.
const TEST_BANK_NAME = 'Mock ASPSP'

export async function getBanks(country: string): Promise<enableBanking.Aspsp[]> {
  return cached(`banks:${country}`, async () => {
    const banks = await enableBanking.listAspsps(country)
    return banks.sort((a, b) => {
      if ((a.name === TEST_BANK_NAME) !== (b.name === TEST_BANK_NAME)) return a.name === TEST_BANK_NAME ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  })
}

export async function isSupportedCountry(country: string): Promise<boolean> {
  return (await getCountries()).includes(country)
}

// Only banks from Enable Banking's own list can be used, so /login can't be pointed at anything else.
export async function findBank(name: string, country: string): Promise<enableBanking.Aspsp | null> {
  if (!(await isSupportedCountry(country))) return null
  return (await getBanks(country)).find((bank) => bank.name === name) ?? null
}
