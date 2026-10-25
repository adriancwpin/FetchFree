import { useMemo, useState } from 'react'
import { Landmark, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useBanks, useCountries } from '@/hooks/useBank'
import type { Bank } from '@/lib/api'
import { countryName, normalise } from '@/lib/format'
import { cn } from '@/lib/utils'

const LAST_BANK_KEY = 'fetchfree:lastBank'
const DEFAULT_COUNTRY = 'FI'
const TEST_BANK_NAME = 'Mock ASPSP'
// Germany alone has ~670 banks; past this, ask the user to search instead of rendering them all.
const MAX_VISIBLE_BANKS = 100

// Matches the theme's input styling. Dropdown options get an explicit background: a transparent
// <select> otherwise shows its options with the theme's light text on the browser's white popup.
const FIELD_CLASS =
  'h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&_option]:bg-popover [&_option]:text-popover-foreground'

interface BankChoice {
  name: string
  country: string
}

// localStorage can be unavailable (private mode, blocked storage), so failures are ignored.
function loadLastBank(): BankChoice | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_BANK_KEY) ?? 'null')
    if (parsed && typeof parsed === 'object' && 'name' in parsed && 'country' in parsed) {
      return { name: String(parsed.name), country: String(parsed.country) }
    }
  } catch {
    // Ignore: fall back to defaults.
  }
  return null
}

function saveLastBank(choice: BankChoice): void {
  try {
    localStorage.setItem(LAST_BANK_KEY, JSON.stringify(choice))
  } catch {
    // Ignore: remembering the bank is only a convenience.
  }
}

const lastBank = loadLastBank()

export function ConnectBank({ loginUrl, error }: { loginUrl: string; error: string | null }) {
  const countries = useCountries()
  const [chosenCountry, setChosenCountry] = useState<string | null>(lastBank?.country ?? null)
  const [selected, setSelected] = useState<string | null>(lastBank?.name ?? null)
  const [search, setSearch] = useState('')

  // Use the remembered or chosen country once we know the app supports it; otherwise a default.
  const available = countries.data ?? []
  const country =
    chosenCountry && available.includes(chosenCountry)
      ? chosenCountry
      : available.includes(DEFAULT_COUNTRY)
        ? DEFAULT_COUNTRY
        : (available[0] ?? '')

  const banks = useBanks(country)
  const selectedBank = banks.data?.find((bank) => bank.name === selected) ?? null

  const filtered = useMemo(() => {
    const query = normalise(search.trim())
    return (banks.data ?? []).filter((bank) => normalise(bank.name).includes(query))
  }, [banks.data, search])

  function changeCountry(code: string) {
    setChosenCountry(code)
    setSelected(null)
    setSearch('')
  }

  const href = selectedBank
    ? `${loginUrl}?${new URLSearchParams({ bank: selectedBank.name, country: selectedBank.country })}`
    : undefined

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Connect your bank</CardTitle>
        <CardDescription>
          Pick your bank. You'll be sent there to approve read-only access to balances and transactions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="bank-country" className="text-sm font-medium">
            Country
          </label>
          {countries.isPending ? (
            <Skeleton className="h-9 w-full" />
          ) : countries.isError ? (
            <p className="text-sm text-destructive">Could not load countries: {countries.error.message}</p>
          ) : (
            <select
              id="bank-country"
              className={FIELD_CLASS}
              value={country}
              onChange={(event) => changeCountry(event.target.value)}
            >
              {[...available]
                .sort((a, b) => countryName(a).localeCompare(countryName(b)))
                .map((code) => (
                  <option key={code} value={code}>
                    {countryName(code)}
                  </option>
                ))}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="bank-search" className="text-sm font-medium">
            Bank
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="bank-search"
              type="search"
              placeholder="Search banks"
              autoComplete="off"
              className={cn(FIELD_CLASS, 'pl-8')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {banks.isPending && country ? (
            <div className="flex flex-col gap-1">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-11 w-full" />
              ))}
            </div>
          ) : banks.isError ? (
            <p className="text-sm text-destructive">Could not load banks: {banks.error.message}</p>
          ) : filtered.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No banks match “{search}”.</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1" aria-label="Banks">
              {filtered.slice(0, MAX_VISIBLE_BANKS).map((bank) => (
                <li key={bank.name}>
                  <BankRow bank={bank} selected={bank.name === selected} onSelect={() => setSelected(bank.name)} />
                </li>
              ))}
              {filtered.length > MAX_VISIBLE_BANKS && (
                <li className="px-2 py-2 text-xs text-muted-foreground">
                  Showing {MAX_VISIBLE_BANKS} of {filtered.length}. Type to narrow the list.
                </li>
              )}
            </ul>
          )}
        </div>

        {href && selectedBank ? (
          <a
            href={href}
            className={buttonVariants({ size: 'lg' })}
            onClick={() => saveLastBank({ name: selectedBank.name, country: selectedBank.country })}
          >
            <Landmark />
            Connect to {selectedBank.name}
          </a>
        ) : (
          <Button size="lg" disabled>
            <Landmark />
            Choose a bank
          </Button>
        )}

        <p className="text-xs text-muted-foreground">
          Sandbox mode: banks use test customers and fake data, no real login needed. Nordea (Finland) has sample
          transactions.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}

function BankRow({ bank, selected, onSelect }: { bank: Bank; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
        selected && 'bg-muted font-medium ring-1 ring-ring',
      )}
    >
      <BankLogo bank={bank} />
      <span className="min-w-0 flex-1 truncate">{bank.name}</span>
      {bank.name === TEST_BANK_NAME && <Badge variant="outline">Test bank</Badge>}
      {bank.beta && <Badge variant="secondary">Beta</Badge>}
    </button>
  )
}

function BankLogo({ bank }: { bank: Bank }) {
  const [failed, setFailed] = useState(false)
  const initials = bank.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()

  if (!bank.logo || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground"
      >
        {initials}
      </span>
    )
  }
  return (
    <img
      src={bank.logo}
      alt=""
      loading="lazy"
      // Logos come from enablebanking.com; don't tell it which page loaded them.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-8 shrink-0 rounded-md bg-white object-contain p-0.5"
    />
  )
}
