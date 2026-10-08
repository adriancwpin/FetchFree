import express from 'express'
import cors from 'cors'
import { config } from './config.js'
import { authRouter, callbackRouter } from './routes/auth.js'
import { accountsRouter } from './routes/accounts.js'

const app = express()

app.use(cors({ origin: config.clientOrigin }))
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/accounts', accountsRouter)
// Mounted at root: must match the registered redirect URI's path exactly.
app.use(callbackRouter)

app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`)
})
