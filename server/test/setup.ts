// Runs before each test file, before any app module is imported, so config.ts sees these values
// instead of the real .env (dotenv never overrides variables that are already set).
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetchfree-test-'))
const keyPath = path.join(dir, 'test-key.pem')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))

process.env.ENABLE_BANKING_APP_ID = 'test-app-id'
process.env.ENABLE_BANKING_PRIVATE_KEY_PATH = keyPath
process.env.CLIENT_ORIGIN = 'http://localhost:5173'
process.env.PORT = '3000'
// A fresh in-memory database per test file: never the real data/fetchfree.db.
process.env.DB_PATH = ':memory:'
