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
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
}
app.use(errorHandler)

app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`)
})
