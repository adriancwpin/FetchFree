import { Router } from 'express'
import * as bankDirectory from '../bankDirectory.js'

export const banksRouter = Router()

banksRouter.get('/countries', async (_req, res) => {
  res.json(await bankDirectory.getCountries())
})

banksRouter.get('/', async (req, res) => {
  const country = typeof req.query.country === 'string' ? req.query.country.toUpperCase() : ''
  if (!(await bankDirectory.isSupportedCountry(country))) {
    res.status(400).json({ error: `Unsupported country: ${country || '(none)'}` })
    return
  }
  const banks = await bankDirectory.getBanks(country)
  res.json(banks.map(({ name, country, logo, beta }) => ({ name, country, logo, beta })))
})
