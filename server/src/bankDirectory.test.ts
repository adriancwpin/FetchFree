import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBank, json } from '../test/fakeBank.js'

const BANKS = [
  { name: 'Mock ASPSP', country: 'FI' },
  { name: 'S-Pankki', country: 'FI' },
  { name: 'Nordea', country: 'FI' },
]

// bankDirectory keeps its cache in module state, so each test loads a fresh copy.
async function loadDirectory() {
  vi.resetModules()
  return import('./bankDirectory.js')
}

function fakeDirectory(countries: string[] = ['FI', 'SE']) {
  return fakeBank((call) => {
    if (call.path === '/application') return json({ countries })
    if (call.path === '/aspsps') return json({ aspsps: BANKS })
    return json({}, 404)
  })
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('bank directory', () => {
  it('sorts banks by name with the Mock test bank last', async () => {
    fakeDirectory()
    const directory = await loadDirectory()

    expect((await directory.getBanks('FI')).map((bank) => bank.name)).toEqual(['Nordea', 'S-Pankki', 'Mock ASPSP'])
  })

  it('caches lists, so repeated lookups make one call to Enable Banking', async () => {
    const calls = fakeDirectory()
    const directory = await loadDirectory()

    await directory.getBanks('FI')
    await directory.getBanks('FI')
    await directory.getCountries()
    await directory.getCountries()

    expect(calls.filter((call) => call.path === '/aspsps')).toHaveLength(1)
    expect(calls.filter((call) => call.path === '/application')).toHaveLength(1)
  })

  it('does not cache a failure: the next call tries again', async () => {
    let fail = true
    fakeBank(() => (fail ? json({ message: 'down' }, 503) : json({ countries: ['FI'] })))
    const directory = await loadDirectory()

    await expect(directory.getCountries()).rejects.toMatchObject({ status: 503 })
    fail = false
    expect(await directory.getCountries()).toEqual(['FI'])
  })

  it('treats an empty country list as an error rather than caching it', async () => {
    fakeDirectory([])
    const directory = await loadDirectory()

    await expect(directory.getCountries()).rejects.toThrow(/no supported countries/)
  })

  it('finds a bank only by its exact name in a supported country', async () => {
    fakeDirectory()
    const directory = await loadDirectory()

    expect(await directory.findBank('Nordea', 'FI')).toMatchObject({ name: 'Nordea', country: 'FI' })
    expect(await directory.findBank('Fake Bank', 'FI')).toBeNull()
    expect(await directory.findBank('Nordea', 'GB')).toBeNull()
  })
})
