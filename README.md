# FetchFree

[![Test](https://github.com/adriancwpin/FetchFree/actions/workflows/test.yml/badge.svg)](https://github.com/adriancwpin/FetchFree/actions/workflows/test.yml)

**FetchFree is a personal finance dashboard that connects to your bank through open banking (PSD2) and shows where your money goes.** It is self-hosted and read-only.

You connect a bank account through [Enable Banking](https://enablebanking.com). FetchFree then shows:

- your balances
- your last six months of transactions
- a monthly summary of money in and money out
- your spending by category, with optional monthly budgets

FetchFree has **read-only** access to your accounts and can never move money. It runs entirely on your own computer, and your transactions are stored in a local database, never on a third-party service.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Security and privacy](#security-and-privacy)
- [Technology](#technology)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)

---

## Features

### Bank connection
- **Bank picker.** Choose your country and bank from Enable Banking's directory, then sign in on your bank's own website. FetchFree never sees your bank password.
- **Lasting connection.** The connection survives a server restart. It lasts until the bank's consent expires (up to 10 days) or until you disconnect.
- **Expiry warning.** Two days before the connection expires, a warning shows how much time is left and offers a one-click **Reconnect**. If the app is open when the connection expires, it switches to read-only mode without a reload.
- **Read-only mode after the connection ends.** When a connection expires or is revoked at the bank, your saved transactions, budgets and categories stay visible until you reconnect.

### Transactions and insights
- **Six months of history.** FetchFree fetches up to six months of transactions and keeps them in a local SQLite database. Your history stays available after the bank stops returning older transactions.
- **Saved copy first.** Pages load from the saved copy, and FetchFree asks the bank only when the data is out of date or when you click **Refresh**. If the bank is unavailable, you still see your saved data and the time it was last updated.
- **Pending and booked transactions.** Pending transactions are shown separately. They are replaced by the booked transaction once it settles.
- **Money in vs. money out.** A monthly summary of income, spending and net change.
- **Spending by category.** Transactions are sorted into categories automatically (groceries, eating out, transport, bills and so on), with a chart of where the money went.

### Personalisation
- **Category corrections.** If a category is wrong, change it once. The correction becomes a rule for that payee and covers past and future transactions from them.
- **Monthly budgets.** Set a monthly limit for any category. FetchFree compares your spending with how far through the month you are, so it can show when you are on track or likely to overspend.
- **Kept across reconnects.** Budgets, rules and saved transactions are tied to the account itself, not to a single bank connection, so they are kept when you reconnect.

---

## How it works

```
┌────────────────────┐      ┌─────────────────────────┐      ┌──────────────────┐      ┌────────┐
│  Browser           │      │  FetchFree server       │      │  Enable Banking  │      │  Your  │
│  React + Vite      │ ───▶ │  Express (loopback)     │ ───▶ │  API (PSD2)      │ ───▶ │  bank  │
│  localhost:5173    │      │  localhost:3000         │      │                  │      │        │
└────────────────────┘      │  SQLite: sessions,      │      └──────────────────┘      └────────┘
                            │  transactions, budgets, │
                            │  category rules         │
                            └─────────────────────────┘
```

1. **Connect.** You choose a bank in the app. The server starts an OAuth-style authorisation with Enable Banking and sends your browser to the bank, where you sign in and grant consent.
2. **Callback.** The bank sends your browser back to the server with a one-time code. The server checks that the code belongs to a login this browser started, then exchanges it for a session.
3. **Sync.** The server fetches balances and transactions from Enable Banking, signing each request with your application's private key. It stores the transactions in SQLite and serves the app from this saved copy.
4. **Analyse.** The browser works out the summaries, categories and budget progress from the transactions the server returns.

The private key never leaves the server, and the browser only talks to the server.

---

## Security and privacy

- **Read-only access.** FetchFree only asks for account information consent. It has no ability to initiate payments.
- **Local only.** The API listens on the loopback interface (`127.0.0.1` / `::1`), so other devices on your network cannot reach it. FetchFree has no user accounts, which is why the API must not be exposed beyond your own computer.
- **Protected login flow.** Each bank login is tied to the browser that started it with a single-use `state` value and a matching cookie. Logins expire after 15 minutes. This prevents login cross-site request forgery (CSRF), where someone else's callback link could attach their account to your app.
- **Logins started only by you.** A bank login can only be started by opening the link directly. Other websites cannot start logins in the background.
- **Secrets kept out of git.** The Enable Banking private key (`*.pem`), `server/.env` and the database (`server/data/`) are all gitignored.
- **Old connections revoked.** When you reconnect or disconnect, FetchFree also cancels the old session at Enable Banking.

---

## Technology

| Layer | Technologies |
|---|---|
| Client | React 19, TypeScript, Vite, TanStack Query, Zod, Tailwind CSS, shadcn/ui (Base UI) |
| Server | Node.js (≥ 22.5), Express 5, TypeScript, built-in `node:sqlite`, JSON Web Tokens for Enable Banking authentication |
| Testing | Vitest, Supertest, a fake Enable Banking API, an in-memory SQLite database |
| CI | GitHub Actions: tests, type checks, lint and build on every push and pull request |

---

## Getting started

### Prerequisites

- **Node.js 22.5 or newer.** The server uses Node's built-in SQLite module. CI uses Node 24.
- **An Enable Banking application.** Sandbox mode is fine. Your application needs:
  - the redirect URL **`http://localhost:3000/callback`**, registered exactly as written
  - its private key file (`<application-id>.pem`), which you download when you create the application

### Installation

```bash
git clone https://github.com/adriancwpin/FetchFree.git
cd FetchFree

# Install dependencies
cd server && npm install
cd ../client && npm install

# Create the server configuration
cd ../server
cp .env.example .env
```

Edit `server/.env` with your application ID and key path (see [Configuration](#configuration)). Then put the `.pem` file in `server/`.

> **Important:** never commit the `.pem` file. Anyone who has it can act as your Enable Banking application.

### Running

Run the server and the client in two separate terminals:

```bash
cd server && npm run dev     # API on http://localhost:3000
cd client && npm run dev     # App on http://localhost:5173
```

Open **http://localhost:5173**, choose a country and bank, and click **Connect**.

**Sandbox banks.** In sandbox mode every bank has fake customers and no real money. **Nordea (Finland)** includes sample transactions. **Mock ASPSP** connects, but its account is empty.

---

## Configuration

The server reads its settings from `server/.env`:

| Variable | Required | Description |
|---|---|---|
| `ENABLE_BANKING_APP_ID` | Yes | Your Enable Banking application ID. |
| `ENABLE_BANKING_PRIVATE_KEY_PATH` | Yes | Path to the application's private key, e.g. `./<application-id>.pem`. |
| `CLIENT_ORIGIN` | Yes | Where the client runs. Default: `http://localhost:5173`. |
| `PORT` | Yes | The server port. It must match the registered redirect URL (`3000`). |
| `DB_PATH` | No | Where the SQLite database is stored. Default: `./data/fetchfree.db`. |
| `HOST` | No | The interface the server listens on. Default: loopback only. Don't change it unless the API is protected another way. |

---

## Testing

```bash
cd server && npm test        # API routes, login checks, paging, storage, sync
cd client && npm test        # summaries, categories, budgets, formatting, expiry timing, API handling
```

- **Isolated.** The tests never call Enable Banking and never read your `.env`, private key or database. They use a fake bank, a throwaway key and an in-memory database.
- **Other checks:**
  - `npm run test:watch` re-runs the tests as you edit.
  - `npm run typecheck` (server) type-checks the tests too.
  - `npm run lint` and `npm run build` (client) check code style and the production build.
- **CI.** GitHub Actions runs everything on every push and pull request ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

---

## Project structure

```
FetchFree/
├── client/                 React + Vite web app
│   └── src/
│       ├── components/     Accounts view, transactions table, summaries, budgets, connection status
│       ├── hooks/          Data fetching and caching (TanStack Query)
│       └── lib/            API client, categories, budgets, summaries, formatting, expiry timing
├── server/                 Express API (holds the Enable Banking key)
│   ├── src/
│   │   ├── routes/         Auth (login, callback, status), banks, accounts
│   │   ├── *Store.ts       SQLite storage: sessions, transactions, budgets, category rules
│   │   └── enableBankingClient.ts
│   └── test/               Test setup and the fake Enable Banking API
└── .github/workflows/      Continuous integration
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| The server exits with `Missing required environment variable` | `server/.env` is missing or incomplete. See [Configuration](#configuration). |
| After the bank login: *"The bank login could not be verified"* | The login took longer than 15 minutes, or it was started in a different browser. Start again from the app. |
| The bank reports an invalid redirect URL | The server must run on port **3000**, to match the redirect URL registered with Enable Banking. |
| The app shows *"Could not reach the server"* | Start the server with `cd server && npm run dev`. |
| The API can't be reached from another device | This is intentional. The API has no authentication, so it only listens on this computer. |
| Connected, but no transactions appear | That bank's test account has no transactions. Try **Nordea (Finland)**. |

---

## Known limitations

- **Single user.** There are no user accounts. FetchFree is designed for one person on one computer.
- **No UI tests.** The application logic has automated tests, but the React components don't yet.
- **No in-app data deletion.** Saved transactions are pruned after six months. To remove everything immediately, delete `server/data/`.
- **Payee-level categories only.** You can't yet write rules based on message text, create custom categories or search transactions.
- **Warnings only in the app.** The expiry warning appears only while FetchFree is open. There are no email or push notifications.

---

## Documentation

For a detailed explanation of the login flow, data model, sync strategy and security decisions, see **[docs/system-design.md](docs/system-design.md)**.
