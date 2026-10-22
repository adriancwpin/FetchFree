import fs from 'node:fs'
import 'dotenv/config'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const privateKeyPath = requireEnv('ENABLE_BANKING_PRIVATE_KEY_PATH')
const port = Number(process.env.PORT ?? 3000)

export const config = {
  appId: requireEnv('ENABLE_BANKING_APP_ID'),
  privateKey: fs.readFileSync(privateKeyPath),
  port,
  // Loopback only by default: the API has no login yet, so it must not be reachable from the network.
  host: process.env.HOST ?? '127.0.0.1',
  clientOrigin: requireEnv('CLIENT_ORIGIN'),
  // Must exactly match the redirect URI registered with Enable Banking for this app.
  callbackUrl: `http://localhost:${port}/callback`,
  apiBaseUrl: 'https://api.enablebanking.com',
  dbPath: process.env.DB_PATH ?? './data/fetchfree.db',
}
