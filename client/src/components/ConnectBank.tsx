import { Landmark, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useStartAuth } from '@/hooks/useBank'

export function ConnectBank({ error }: { error: string | null }) {
  const startAuth = useStartAuth()
  const message = startAuth.error?.message ?? error

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Connect your bank</CardTitle>
        <CardDescription>
          You'll be sent to your bank to approve read-only access to balances and transactions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button size="lg" onClick={() => startAuth.mutate()} disabled={startAuth.isPending}>
          {startAuth.isPending ? <Loader2 className="animate-spin" /> : <Landmark />}
          Connect bank
        </Button>
        {message && <p className="text-sm text-destructive">{message}</p>}
      </CardContent>
    </Card>
  )
}
