import { Loader2, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDisconnect } from '@/hooks/useBank'

export function ConnectionBar({ validUntil }: { validUntil: string | null }) {
  const disconnect = useDisconnect()

  return (
    <div className="flex w-full items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground">
        {validUntil
          ? `Connected until ${new Date(validUntil).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}`
          : 'Connected'}
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
