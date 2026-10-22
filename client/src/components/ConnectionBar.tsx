import { Loader2, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDisconnect } from '@/hooks/useBank'
import { countryName } from '@/lib/format'

export function ConnectionBar({
  validUntil,
  bank,
}: {
  validUntil: string | null
  bank: { name: string; country: string } | null
}) {
  const disconnect = useDisconnect()
  const until = validUntil
    ? ` until ${new Date(validUntil).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : ''

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="text-sm text-muted-foreground">
        Connected
        {bank && (
          <>
            {' to '}
            <span className="font-medium text-foreground">{bank.name}</span> (
            {countryName(bank.country)})
          </>
        )}
        {until}
      </p>
      <div className="flex items-center gap-3">
        {disconnect.isError && (
          <span className="text-sm text-destructive">{disconnect.error.message}</span>
        )}
        <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
          {disconnect.isPending ? <Loader2 className="animate-spin" /> : <Unplug />}
          Disconnect
        </Button>
      </div>
    </div>
  )
}
