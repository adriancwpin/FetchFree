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

export const config = {
  appId: requireEnv('ENABLE_BANKING_APP_ID'),
  privateKey: fs.readFileSync(privateKeyPath),
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: requireEnv('CLIENT_ORIGIN'),
  apiBaseUrl: 'https://api.enablebanking.com',
}
