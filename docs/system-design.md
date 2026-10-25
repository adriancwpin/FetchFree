# FetchFree: System Design

This explains how the whole app works: what each part does, how data moves between the parts, and *why* it's built this way. Read it top to bottom once. After that, the **Check yourself** questions at the end are the best way to make it stick.

> Status: describes the code as of the `feat/tests` branch (October 2026), including the bank picker and the automated tests.

---

## 1. What the app does

FetchFree connects to your bank through **Enable Banking**, a licensed "open banking" provider. It then shows:

- your accounts and their balances
- the last 6 months of transactions
- a monthly **money in vs money out** summary with a chart

It only ever **reads** data. It can't move money.

---

## 2. The big picture

There are four moving parts, plus your bank:

```
 ┌──────────────────────┐        ┌──────────────────────────┐        ┌───────────────────────┐
 │  Browser             │  /api  │  Server (Express)        │ HTTPS  │  Enable Banking API   │
 │  React app (client)  │ ─────▶ │  localhost:3000          │ ─────▶ │  api.enablebanking.com│
 │  localhost:5173      │ ◀───── │  holds the private key   │ ◀───── │                       │
 └──────────────────────┘        └────────────┬─────────────┘        └───────────┬───────────┘
            │  redirect to bank login          │ reads/writes                     │ talks to
            └─────────────────────────────────▶│                                  ▼
                                    ┌──────────▼─────────┐               ┌───────────────┐
                                    │ SQLite file        │               │ Your bank     │
                                    │ data/fetchfree.db  │               │ (or sandbox)  │
                                    └────────────────────┘               └───────────────┘
```

| Part | Runs where | Job |
|---|---|---|
| **Client** (`client/`) | In your browser. Served by Vite at `localhost:5173`. | Shows the pages, buttons and chart. Does the summary maths. Has **no secrets**. |
| **Server** (`server/`) | Node.js on your machine, at `localhost:3000`. | Holds the **private key**. Talks to Enable Banking. Remembers the connection. |
| **Database** | A single file, `server/data/fetchfree.db` | Remembers logins in progress and the current bank connection, so they survive restarts. |
| **Enable Banking** | Internet | The go-between that is legally allowed to talk to banks (PSD2). |
| **Bank** | Internet | Owns your data. In sandbox mode this is a *test* bank with fake customers. |

**Why the split?** Everything in the browser can be read by anyone using it. The private key proves to Enable Banking that requests come from *your* app, so it must stay on the server. The browser asks the server, and the server asks the bank.

---

## 3. Tech stack

| Layer | Tool | Why it's used |
|---|---|---|
| UI | **React 19** + **TypeScript** | Components plus type checking catch mistakes early. |
| Dev server / bundler | **Vite** | Fast reloads. Its **proxy** forwards `/api/*` to the server, so the browser only ever talks to one address. |
| Styling | **Tailwind CSS 4** + **shadcn/ui** components | Ready-made Button, Card, Table, Badge and Skeleton, styled with utility classes. |
| Data fetching | **TanStack React Query** | Caching, loading and error states, and retries, without hand-written state code. |
| Validation | **zod** | Checks that the server's responses have the shape the UI expects. |
| Server | **Express 5** (Node 24) | Small HTTP framework. Express 5 automatically forwards errors from `async` routes. |
| Auth to Enable Banking | **jsonwebtoken** (RS256) | Signs a short-lived JWT with the private key on every request. |
| Database | **`node:sqlite`** (built into Node) | No install, a single file. Fine for one local user. Postgres comes later, when going online. |

---

## 4. Main flows

### 4.1 Connecting a bank (the login flow)

This is the most important flow to understand. It's an **OAuth-style redirect flow**: the app never sees your bank password. You type it on the bank's own site, and the bank hands back a one-time **code**.

```
You        Client (5173)         Server (3000)              Enable Banking / Bank
 │  pick bank │                       │                              │
 │──────────▶ │ navigate to           │                              │
 │            │ /login?bank=Nordea&country=FI                        │
 │            │──────────────────────▶│ 1. look bank up in its list  │
 │            │                       │ 2. make random `state`,      │
 │            │                       │    save in DB (pending)      │
 │            │                       │ 3. POST /auth ──────────────▶│
 │            │                       │◀──────────── bank login URL ─│
 │            │                       │ 4. set cookie                │
 │            │                       │    fetchfree_auth_<state>    │
 │◀───────────────── 302 redirect to the bank's login page ──────────│
 │  log in + approve at the bank ───────────────────────────────────▶│
 │◀──── 302 redirect to localhost:3000/callback?code=…&state=… ──────│
 │──────────────────────────────────────▶│ 5. check: cookie for this   │
 │                                       │    state exists AND state   │
 │                                       │    is pending (then delete) │
 │                                       │ 6. POST /sessions {code} ──▶│
 │                                       │◀── session_id + accounts ───│
 │                                       │ 7. save session in DB,      │
 │                                       │    revoke any old ones      │
 │◀── 302 redirect to localhost:5173/?connected=1 ──────────────────────
```

The key ideas, step by step:

- **`state`** (step 2) is a random ID created for *this* login. When the bank sends you back, the `state` comes back with you. If the server doesn't recognise it, the callback is rejected (`invalid_state`). This stops forged callbacks. Each `state` works **once** and expires after **15 minutes**.
- **The cookie** (step 4) ties the `state` to *your browser*. Without it, someone could start a login with *their* bank account and send you the callback link. Your app would then show *their* account (an attack called "login CSRF"). The cookie is:
  - `HttpOnly`, so JavaScript can't read it
  - `SameSite=Lax`, so it's still sent when the bank redirects you back
  - limited to the `/callback` path
- **Why the login starts on the server (`/login`)** rather than the client: cookies belong to a *host* (like `localhost`). Starting on the server means the cookie is set on exactly the host the bank later redirects back to.
- **The redirect URL** `http://localhost:3000/callback` is registered with Enable Banking. If it doesn't match exactly, the bank refuses. That's why the server must run on port 3000.
- **One connection at a time.** A new login replaces the old one, and the old one is cancelled at the bank in the background.

Code: [server/src/routes/auth.ts](../server/src/routes/auth.ts), [server/src/sessionStore.ts](../server/src/sessionStore.ts).

### 4.2 Showing accounts, balances and transactions

```
Browser ─GET /api/auth/status─▶ Server ─▶ DB: is there a live session?
        ◀── { connected, validUntil, bank, loginUrl }

Browser ─GET /api/accounts──────▶ Server ─▶ DB: the session's account list (no bank call)
Browser ─GET /api/accounts/:uid/balances─────▶ Server ─▶ Enable Banking
Browser ─GET /api/accounts/:uid/transactions─▶ Server ─▶ Enable Banking (several pages)
```

Details worth knowing:

- **Account guard.** The server only fetches data for account IDs that belong to the current session (`requireSessionAccount`). Any other ID gets a 404.
- **Pagination.** Banks return transactions in pages. Each response includes a `continuation_key` ("next page" ticket). The server follows these until there are none left, with two safety stops:
  - a maximum of **20 pages**
  - stopping if the bank **repeats** a key (which would otherwise double-count)

  If it stops early, the response says `truncated: true` and the UI shows a warning.
- **History window.** The server asks for transactions from the 1st of the month, 5 months ago (6 months including this one). Some banks refuse more than ~90 days, and if one refuses on the **first page** with a 400 or 422, the server retries **once** with 89 days. The response always reports `dateFrom` and `dateTo`, so the client never guesses the window. This makes the server the **single source of truth**.
- **PSU headers.** The user's IP and browser are sent as `Psu-Ip-Address` and `Psu-User-Agent`. They tell the bank the user is actually present. Some banks require them, and PSD2 lets banks cap reads made *without* the user present (~4 per day).
- **Balances.** Banks return several balance types. The UI prefers "available" (`ITAV`/`CLAV`) and labels it in plain English.

Code: [server/src/routes/accounts.ts](../server/src/routes/accounts.ts), [server/src/enableBankingClient.ts](../server/src/enableBankingClient.ts).

### 4.3 The spending summary (all in the browser)

`summarizeByMonth()` in [client/src/lib/summary.ts](../client/src/lib/summary.ts) is a **pure function**: transactions go in, totals come out. It never fetches or draws anything. That's why it's easy to test.

1. **Filter.** Keep transactions dated inside the window (`dateFrom` to `dateTo` + 1 day; the extra day covers timezones ahead of UTC).
2. **Settled only.** Count `BOOK` (or no status). The rest are excluded and explained in the UI:
   - *not yet* settled: `PDNG`, `SCHD`, `HOLD`
   - *never* counted: `CNCL`, `RJCT`, `INFO`
3. **Pick the currency.** Use the account's own currency, if transactions actually use it. Otherwise use the most common one. Never add € and £ together; other currencies are counted as "skipped".
4. **Bucket by month.** `"2026-10-14"` becomes `"2026-10"`. Money **in** is `CRDT` (or a positive amount), and money **out** is `DBIT` (or a negative amount).
5. **Sum in whole cents.** Using integers avoids floating-point errors like `0.1 + 0.2 ≠ 0.3`.

`SpendingSummary.tsx` then draws:
- the stat row (In / Out / Net)
- the bar chart in plain HTML and CSS, with no chart library
- a hover tooltip
- a hidden table for screen readers

### 4.4 Disconnecting

`DELETE /api/auth/session` deletes the sessions from the database straight away, then asks Enable Banking to revoke them **in the background**. A slow bank never blocks the user. The client switches to the Connect screen *before* removing cached account data, so there's no error flash.

### 4.5 Spending categories

Banks rarely send a category. Nordea's `merchant_category_code` is empty on every transaction, so [categories.ts](../client/src/lib/categories.ts) works it out from **text**:

```
counterparty name  +  payment message  +  bank's transaction type
"K market Helsinki"   "18110005577890"     "Korttiosto" (card purchase)
                         │ lower-case, remove accents
                         ▼
          check rules in order → first match wins → "groceries"
```

- **Rules** are regular expressions in a fixed order, separate for money out (`OUT_RULES`) and money in (`IN_RULES`). They cover English and Finnish ("vuokra" = rent, "nosto" = withdrawal), and match whole words, so "steam" doesn't match "Steamboat". Money-out rules run in three tiers:
  1. **What the bank says the transaction is**: own transfer, ATM withdrawal. An own transfer that mentions "rent" is still a transfer.
  2. **Named merchants and kinds of business**: groceries, eating out, transport, travel… Transport comes before travel, so a taxi or car hire at an airport is transport.
  3. **Generic words that might also be part of a merchant's name** ("internet", "rent"), so "Internet Pizza Oy" is eating out, not a bill.
- **Fallbacks:** an unmatched card purchase → Shopping. A payment to something that looks like a person's name → Payments to people (or From people). Everything else → Other.
- **The totals always match the chart.** `countedTransactions()` in [summary.ts](../client/src/lib/summary.ts) decides which transactions count (in the window, settled, in the summary currency), and both the monthly chart and `breakdownByCategory()` use it. A test checks that the category totals equal "Money in" and "Money out".
- **The filtered table matches the breakdown.** Clicking a category lists `transactionsFor(counted, selection)`, the same function the breakdown totals. So the rows always add up to the amount you clicked, without pending or other-currency entries.
- **Each transaction's category is computed once** and cached per transaction object (a `WeakMap`), because the table, breakdown and filter all ask for it on every render.
- **It runs in the browser**, like the summary: there's no stored data to categorise on the server yet.
- **Adding a rule:** add a `{ category, match: /…/ }` line in the right place in `OUT_RULES` or `IN_RULES`, plus a test case in `categories.test.ts`. On the Nordea sandbox data, 97% of transactions get a real category.

The UI ([CategoryBreakdown.tsx](../client/src/components/CategoryBreakdown.tsx)) ranks categories by amount, with a Spending/Income switch and a month picker. Clicking a category filters the transactions table. The bars use one colour per direction: it's one series ranked by size, so a rainbow of colours would add nothing.

---

## 5. Data model (SQLite)

All SQL lives in **two files**: [db.ts](../server/src/db.ts) and [sessionStore.ts](../server/src/sessionStore.ts). Switching to Postgres later means rewriting just those two.

```
pending_auths                       bank_sessions
─────────────────────────           ─────────────────────────────
state         TEXT  PK              session_id    TEXT  PK
created_at    TEXT                  accounts      TEXT  (JSON array)
aspsp_name    TEXT  (bank)          valid_until   TEXT  (ISO date)
aspsp_country TEXT                  created_at    TEXT
                                    aspsp_name    TEXT  (bank)
                                    aspsp_country TEXT
```

- **`pending_auths`** holds logins that have started but not finished. A row is deleted when its callback arrives, or after 15 minutes.
- **`bank_sessions`** holds the current connection: at most one live row.
- Dates are stored as ISO strings (`2026-11-01T13:00:00.000Z`). They're always written in that exact format, so comparing them as **text** gives the right order.
- **Migrations.** When a new version adds columns, `addColumnIfMissing()` adds them to an existing database without losing rows.

Balances and transactions are **not stored**. They're fetched live each time and cached for 5 minutes in the browser.

---

## 6. API reference (server)

| Method & path | What it does |
|---|---|
| `GET /api/auth/status` | `{ connected, validUntil, bank, loginUrl }` |
| `DELETE /api/auth/session` | Disconnect: clears the sessions and revokes them at the bank |
| `GET /api/banks/countries` | Country codes this app is enabled for |
| `GET /api/banks?country=FI` | Banks in that country (name, logo, beta) |
| `GET /api/accounts` | The connected accounts |
| `GET /api/accounts/:uid/balances` | Balances for one account |
| `GET /api/accounts/:uid/transactions` | `{ transactions, dateFrom, dateTo, truncated }` |
| `GET /login?bank=…&country=…` | *Browser navigation*, not fetch: starts a bank login |
| `GET /callback?code=…&state=…` | *The bank redirects here* after you approve |

Errors come back as JSON: `{ "error": "message" }`. Errors that come from Enable Banking keep their status code (e.g. 401, 429, 504).

---

## 7. Security design

| Threat | Defence |
|---|---|
| Someone on your Wi-Fi reads your bank data | The server listens on **loopback only** (`127.0.0.1` and `::1`), so other devices can't reach it. The API has no login yet, so this is essential. |
| A forged or someone-else's bank callback | Random single-use `state` + an `HttpOnly` cookie per login, checked at `/callback`. |
| Private key leak | `.pem` and `.env` are gitignored, and the key never leaves the server. |
| Reading accounts that aren't yours | `requireSessionAccount` only allows account IDs from the current session. |
| `/login` pointed at an arbitrary bank | Only banks from Enable Banking's own list are accepted. |
| Bank data committed to GitHub | `data/` is gitignored. |

**Not done yet:** user accounts and login. Before the app goes online, each user needs their own login and session (see §10).

---

## 8. Reliability design

- **Timeouts.** Every Enable Banking request gives up after **30 s**, and the 504 error is clear.
- **Readable failures.** Network errors become **502**, and HTML error pages from proxies keep their real status.
- **Retry policy (client).** Only network failures and 5xx errors are retried, at most twice. 4xx errors and malformed responses fail the same way every time, so they aren't retried; a retry of transactions can mean 20 bank calls.
- **Caching:**
  - In the browser, bank data is fresh for **5 minutes** and isn't refetched on every tab switch.
  - On the server, the bank list is cached for **1 hour**, and a failed fetch is not cached.
- **Restarts.** Logins in progress and the connection are in SQLite, so saving a file (which restarts the dev server) doesn't log you out.

---

## 9. Key design decisions and trade-offs

| Decision | Why | Cost |
|---|---|---|
| SQLite now, Postgres later | No setup, and faster for one local user. | Weak for many users at once, so it must be swapped before going online (SQL is isolated to make that easy). |
| Server decides the date window | One source of truth means no timezone mismatch between server and browser. | The client depends on the server's response shape. |
| Summary maths in the browser | Uses data already fetched, with no extra server code or storage. | Recomputed on each render (cheap at this size). |
| No chart library | Smaller app, and full control over accessibility and colours. | Fancier charts would mean more hand-written code. |
| One bank connection at a time | Simple data model and simple UI. | You can't see two banks at once yet. |
| Login starts on the server (`/login`) | The cookie lands on the same host as `/callback`, so the CSRF protection works reliably. | The client needs `loginUrl` from `/status`. |

---

## 10. Known limitations and what's next

1. **No users or login.** It's one shared connection, and safe only because the server is loopback-only.
2. **No UI tests.** The logic is covered by automated tests (§11), but the React components aren't.
3. **Transactions aren't stored**, so there's no history beyond what the bank returns.
4. **Categories are automatic only.** You can't change a transaction's category or add your own rules from the app yet; that needs stored transactions. There's no search or weekly view either.
5. If the bank revokes a session from its side, the app shows errors until you click Disconnect.

---

## 11. Testing

Run `npm test` in `server/` and in `client/`. GitHub Actions runs both on every push and pull request.

| Where | What it covers | How it fakes the outside world |
|---|---|---|
| `server/src/sessionStore.test.ts` | Single-use, expiring logins; replacing and revoking sessions | In-memory SQLite (`DB_PATH=:memory:`) |
| `server/src/db.migration.test.ts` | An old-format database gains the new columns and keeps its session | A temporary database file with the old schema |
| `server/src/enableBankingClient.test.ts` | Timeouts, error pages, paging, the 89-day fallback rules, PSU headers, consent clamp | `fetch` replaced by a fake Enable Banking (`test/fakeBank.ts`) |
| `server/src/bankDirectory.test.ts` | Caching, failures not cached, bank lookup | Fake Enable Banking |
| `server/src/routes.test.ts` | The whole HTTP flow: `/login` guard, `/callback` state and cookie checks, account guard, error handling | supertest calls `app` directly, without a real server |
| `client/src/lib/*.test.ts` | Summary maths, categories (real Nordea examples, totals match the chart), formatting, API error and retry rules | `fetch` replaced in the API tests |

`server/test/setup.ts` runs before every server test file. It generates a throwaway private key and sets the environment variables, so tests never read your real `.env`, key or database.

Splitting `app.ts` (the Express app) from `server.ts` (listening on ports) exists for testing: it lets supertest use the app without opening ports.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **ASPSP** | "Account Servicing Payment Service Provider", i.e. a **bank**. Enable Banking calls banks ASPSPs. |
| **PSU** | "Payment Service User", i.e. **you**, the account holder. |
| **PSD2** | EU law that forces banks to offer APIs to licensed providers like Enable Banking. |
| **Sandbox** | Enable Banking's test mode, with fake banks, fake customers and no real money. |
| **OAuth redirect flow** | You approve on the bank's own site, and the app gets a one-time code instead of your password. |
| **`state`** | A random value that links the start of a login to its callback, to stop forgeries. |
| **JWT** | A signed token. The server signs one with the private key, so Enable Banking knows who's calling. |
| **CRDT / DBIT** | Credit (money in) / debit (money out). |
| **BOOK / PDNG** | Booked (settled) / pending transaction status. |
| **Proxy (Vite)** | In development, Vite forwards `/api/*` from port 5173 to the server on port 3000. |
| **Loopback** | The address `127.0.0.1` / `::1`, meaning "this computer only". |

---

## 13. Check yourself

Try to answer each from memory before opening the answer.

<details><summary>1. Why can't the private key live in the React app?</summary>
Everything shipped to the browser can be read by whoever uses it. With the key, anyone could impersonate your app to Enable Banking.
</details>

<details><summary>2. What two checks must pass at <code>/callback</code>, and what does each one stop?</summary>
(a) The <code>state</code> must be pending in the database. That stops made-up or replayed callbacks, because each state is single-use and expires in 15 minutes. (b) A cookie for that state must be present. That stops someone else's login link being finished in your browser (login CSRF).
</details>

<details><summary>3. Why does the login start at <code>localhost:3000/login</code> instead of a fetch from the client?</summary>
Cookies belong to a host. Starting on the server sets the cookie on the same host the bank redirects back to (<code>localhost:3000/callback</code>), so it's always sent.
</details>

<details><summary>4. A bank returns 400 on page 3 of transactions. Does the server retry with 89 days? Why or why not?</summary>
No. A date-range refusal only makes sense on the <b>first</b> page. A later error is a real failure, and retrying would throw away good data and double the bank calls.
</details>

<details><summary>5. Why are amounts added up in cents?</summary>
Computers store decimals approximately: <code>0.1 + 0.2</code> isn't exactly <code>0.3</code>. Whole-number cents add up exactly.
</details>

<details><summary>6. You switch to Postgres. Which files must change?</summary>
<code>server/src/db.ts</code> and <code>server/src/sessionStore.ts</code>. All SQL is isolated there on purpose.
</details>

<details><summary>7. Why does the server listen only on loopback, and what would you need before changing that?</summary>
The API has no user login, so anyone who can reach it can read the bank data. Before exposing it, you need real user authentication (and HTTPS).
</details>

<details><summary>8. A transaction has status <code>PDNG</code>. Is it in the chart? In the table?</summary>
Not in the chart, where it's counted under "not settled yet". Yes in the table, with a "Pending" badge.
</details>
