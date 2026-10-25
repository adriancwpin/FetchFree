# FetchFree

Connect a bank account through [Enable Banking](https://enablebanking.com) and see your balances, your last 6 months of transactions, a monthly **money in vs money out** summary, and a breakdown of **where your money went** by category. Read-only: the app can never move money.

For how it all works (the login flow, the data model, the security choices), see **[docs/system-design.md](docs/system-design.md)**.

## Project layout

```
client/   React + Vite web app (what you see)           → http://localhost:5173
server/   Express API; holds the Enable Banking key     → http://localhost:3000
docs/     System design notes
```

## Prerequisites

- **Node.js 22.5 or newer.** The server uses Node's built-in SQLite. Node 24 is what CI uses.
- **An Enable Banking application** (sandbox is fine), with:
  - the redirect URL **`http://localhost:3000/callback`** registered exactly
  - its private key file (`<application-id>.pem`), downloaded when you created the app

## Setup

```bash
# 1. Install dependencies
cd server && npm install
cd ../client && npm install

# 2. Configure the server
cd ../server
cp .env.example .env
```

Edit `server/.env`:

```
ENABLE_BANKING_APP_ID=<your application id>
ENABLE_BANKING_PRIVATE_KEY_PATH=./<your application id>.pem
CLIENT_ORIGIN=http://localhost:5173
PORT=3000
```

Put the `.pem` file in `server/`. It's gitignored, so never commit it: anyone who has it can act as your app.

## Run

Use two terminals:

```bash
cd server && npm run dev     # API on http://localhost:3000
cd client && npm run dev     # app on http://localhost:5173
```

Open **http://localhost:5173**, pick a country and bank, and click **Connect**.

**Which test bank should I use?** In sandbox mode every bank is a test bank with fake customers. **Nordea (Finland)** has sample transactions. **Mock ASPSP** connects fine, but its account is empty.

The connection is stored in `server/data/fetchfree.db` (gitignored), so restarting the server doesn't log you out. It expires after 10 days, or when you click **Disconnect**.

## Test

```bash
cd server && npm test        # API, login/state checks, paging, database (fake bank, in-memory DB)
cd client && npm test        # summary maths, formatting, API error handling
```

- The tests never call Enable Banking and never touch your `.env`, key or database. They use a fake bank, a throwaway key and an in-memory database.
- `npm run test:watch` re-runs tests as you edit. `npm run typecheck` (server) type-checks the tests too.
- GitHub Actions runs everything on every push and pull request (`.github/workflows/test.yml`).

## Troubleshooting

| Problem | Fix |
|---|---|
| The server crashes with `Missing required environment variable` | `server/.env` is missing or incomplete. See **Setup**. |
| After the bank login: *"The bank login could not be verified"* | The login took longer than 15 minutes, or was started in a different browser. Start again from the app. |
| The bank says the redirect URL is wrong | The server must run on port **3000**, matching the redirect URL registered with Enable Banking. |
| The app shows *"Could not reach the server"* | Start the server (`cd server && npm run dev`). |
| You can't open the API from another device | That's on purpose: the API has no login yet, so it only listens on this computer (`127.0.0.1` / `::1`). Don't change `HOST` unless the API is protected. |
| Connected, but there's no activity | That bank's test account has no transactions. Try **Nordea (Finland)**. |
