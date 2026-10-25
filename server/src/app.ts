import express, { type ErrorRequestHandler } from 'express'
import cors from 'cors'
import { config } from './config.js'
import { EnableBankingError } from './enableBankingClient.js'
import { authRouter, callbackRouter } from './routes/auth.js'
import { accountsRouter } from './routes/accounts.js'
import { banksRouter } from './routes/banks.js'
import { SessionEndedError } from './sessionEnded.js'

// The Express app without a listener, so tests can call it directly (server.ts does the listening).
export const app = express()

app.use(cors({ origin: config.clientOrigin }))
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/accounts', accountsRouter)
app.use('/api/banks', banksRouter)
// Mounted at root: must match the registered redirect URI's path exactly.
app.use(callbackRouter)

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof SessionEndedError) {
    res.status(401).json({ error: err.message, code: err.code })
    return
  }
  if (err instanceof EnableBankingError) {
    console.error(err.message, err.body)
    res.status(err.status).json({ error: err.message, details: err.body })
    return
  }
  // Client errors raised by Express itself (e.g. a malformed JSON body) keep their 4xx status.
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500
  if (status === 500) console.error(err)
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message })
}
app.use(errorHandler)
