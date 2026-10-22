import { Landmark } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// A plain link: the login starts on the server (it sets the login cookie on its own host, then
// redirects to the bank), so the browser has to navigate there rather than call it with fetch.
export function ConnectBank({ loginUrl, error }: { loginUrl: string; error: string | null }) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Connect your bank</CardTitle>
        <CardDescription>
          You'll be sent to your bank to approve read-only access to balances and transactions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <a href={loginUrl} className={buttonVariants({ size: 'lg' })}>
          <Landmark />
          Connect bank
        </a>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}
