import http from 'node:http'
import express, { type ErrorRequestHandler } from 'express'
import cors from 'cors'
import { config } from './config.js'
import { EnableBankingError } from './enableBankingClient.js'
import { authRouter, callbackRouter } from './routes/auth.js'
import { accountsRouter } from './routes/accounts.js'

const app = express()

app.use(cors({ origin: config.clientOrigin }))
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/accounts', accountsRouter)
// Mounted at root: must match the registered redirect URI's path exactly.
app.use(callbackRouter)

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
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

// "localhost" (used by the bank callback and the login link) may resolve to IPv4 or IPv6
// loopback depending on the browser, so the default listens on both — still never the network.
const hosts = config.host === '127.0.0.1' ? ['127.0.0.1', '::1'] : [config.host]
for (const host of hosts) {
  http
    .createServer(app)
    .listen(config.port, host, () => {
      console.log(`Server listening on http://${host.includes(':') ? `[${host}]` : host}:${config.port}`)
    })
    .on('error', (err) => {
      // IPv6 may be disabled on this machine; IPv4 loopback is enough then.
      if (host === '::1') {
        console.warn(`Not listening on [::1]: ${err.message}`)
        return
      }
      throw err
    })
}
