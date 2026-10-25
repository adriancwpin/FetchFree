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
Browser ─GET /api/accounts/:uid/transactions─▶ Server ─▶ DB: saved copy
                                                       └─▶ Enable Banking, only for what's new (§4.6)
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
- **It runs in the browser**, like the summary. Transactions are now saved on the server (§4.6), but categories aren't yet; storing them comes with editing them.
- **Adding a rule:** add a `{ category, match: /…/ }` line in the right place in `OUT_RULES` or `IN_RULES`, plus a test case in `categories.test.ts`. On the Nordea sandbox data, 97% of transactions get a real category.

The UI ([CategoryBreakdown.tsx](../client/src/components/CategoryBreakdown.tsx)) ranks categories by amount, with a Spending/Income switch and a month picker. Clicking a category filters the transactions table. The bars use one colour per direction: it's one series ranked by size, so a rainbow of colours would add nothing.

### 4.6 Saved transactions

The server keeps a copy of every account's transactions in SQLite, so the bank is only asked for **what's new**:

```
GET /transactions
  │
  ├─ saved copy is under 15 minutes old, or a sync failed under 5 minutes ago (and no ?refresh=true)
  │     └─▶ answer from the DB                                 ~0.003 s
  │
  └─ otherwise, sync first:
        first time ever:          ask the bank for the 6-month window   ~3 s, many pages
        after that:               ask from (last sync − 7 days)         ~0.5 s, usually 1 page
                                  …or earlier, back to the oldest saved pending transaction
        last sync was truncated:  ask from the start of the saved data again, to fill in what it missed
        then save it, and answer from the DB
```

- **Saving = "replace the range you just fetched".** Banks don't promise every transaction a stable id, and a pending transaction changes when it's booked. So a sync doesn't match transactions one by one. In one SQL transaction it:
  1. **deletes** the saved rows dated on or after the fetch's start date
  2. deletes saved rows that match a fresh one: the same `entry_reference` (Enable Banking says it's unique and unchanging per account, so this catches moved dates), or an exact copy, found by an indexed **fingerprint** (a SHA-256 hash of the JSON)
  3. **inserts** what the bank just returned
  4. **prunes** rows older than the 6-month window, undated rows not seen in that time, and pending rows older than 89 days (the bank won't confirm those any more)

  Older rows are otherwise never touched. That's the **history**: months the bank no longer returns once your login is more than a few minutes old (~90 days under PSD2).
- **Pending transactions are always re-checked.** Each sync starts early enough to include the oldest saved pending transaction, so the bank's answer settles it: still pending (kept), booked (replaced) or gone (deleted). Pending rows are never counted in the totals anyway, only listed.
- **Undated rows** can't be placed in a date range, so step 1 never deletes them. They're only replaced by a matching fresh copy (step 2).
- **A truncated fetch never deletes by range.** If paging stopped early (20 pages, or a repeated `continuation_key`), the fetch is missing part of its range, so step 1 is skipped. The next sync re-fetches from the start of the saved data. If the bank won't go back that far any more, the part it couldn't re-check becomes a **gap**, and the "too many transactions" warning clears once a fetch completes.
- **One sync per account at a time.** Requests that arrive while a sync is running wait for it (`inFlight` in transactionSync.ts) instead of starting their own.
- **The 7-day overlap** catches transactions the bank books a few days late.
- **Stable account key.** Account `uid`s change with every bank login, so data is saved under Enable Banking's `identification_hash` (a hash of the IBAN and currency), else the IBAN. Disconnecting and reconnecting the same bank picks the history back up. **Disconnect keeps saved transactions** on purpose.
- **Gaps.** After a long break the bank may only go back 89 days, leaving a hole between the old saved data and the new fetch. The older history is still shown, the hole is saved as a **gap** (`gap_from`–`gap_to`), and the chart says "Some transactions from … to … may be missing". A later sync that reaches back into it fills it. Only one gap is tracked; a second one is merged with it.
- **If the bank fails temporarily** (5xx, 429 or a timeout) while saved data exists, the page loads from the saved copy with `syncError` set, and the UI says "Couldn't reach your bank". The failure is recorded, so automatic syncs wait 5 minutes before asking again instead of waiting for a timeout on every load; Refresh still tries straight away.
- **Other failures still come through.** A 401/403 means the consent expired or was revoked, so you need to reconnect, and saved data would hide that. With nothing saved, any error comes through as before.
- **Same response shape as before**, plus `lastSyncedAt`, `syncError` and `gap`. That's why the summary, categories and table code didn't change. The UI shows "Updated 3 minutes ago · Refresh"; Refresh adds `?refresh=true`. A failed Refresh shows its own error until newer data arrives.

Code: [server/src/transactionSync.ts](../server/src/transactionSync.ts) (when and how far back to fetch), [server/src/transactionStore.ts](../server/src/transactionStore.ts) (the SQL).

### 4.7 Budgets

A budget is a **monthly spending limit for one category**, e.g. Groceries €300, the same every month.

- **Where they live:** the `budgets` table, through `GET/PUT/DELETE /api/accounts/:uid/budgets[/:category]`. Amounts are stored in **whole cents**, like all money maths in the app. Budgets are filed under the stable account key (§4.6), so they survive reconnecting the bank.
- **The server doesn't know the category list.** It only checks that the id looks like one (`/^[a-z][a-zA-Z]{0,39}$/`) and that the amount is between 0 and 1,000,000,000 with at most 2 decimals. The client ignores budgets for ids it doesn't recognise.
- **The maths runs in the browser**, in `budgetProgress()` ([client/src/lib/budgets.ts](../client/src/lib/budgets.ts)), a pure function like the summary:
  - **spent** reuses `breakdownByCategory(counted, 'out', month)`, so a budget always shows the same amount as its row in the category breakdown (a test checks this)
  - **pace** is how much of the month has gone by: today's day ÷ days in the month for the current month, and 1 for a past month
  - **status:** `over` if spent > limit; `ahead` ("Spending fast") if spent ÷ limit is more than 10 points ahead of pace; otherwise `onTrack`. The UI says it in words as well as colour.

  ```
  Groceries    €120.40 of €300
  [██████████░░░░░│░░░░░░░░░░]   ← bar = spent ÷ limit, │ = pace (how far through the month)
  On track                    €179.60 left
  ```
- **Which month:** the one picked in the breakdown's Period select, or the current month for "All months". Clicking a budget filters the transactions table to that category and month, through the same shared `selection` as the breakdown.
- **Editing** uses mutations that write the result straight into the cached budget list (`setQueryData`), so the list updates without a refetch.

Code: [server/src/budgetStore.ts](../server/src/budgetStore.ts), [client/src/components/Budgets.tsx](../client/src/components/Budgets.tsx).

### 4.8 When a bank connection ends

A connection ends in two ways:
1. **It expires.** Our `valid_until` passes (at most 10 days after connecting).
2. **The bank ends it early**, e.g. you revoke access in your bank's app, or the bank closes it.

```
Account-data request fails with 4xx (not 429)
  │
  ├─ ask Enable Banking: GET /sessions/{id}
  │     ├─ "AUTHORIZED"            → not a session problem: pass the original error through
  │     ├─ check itself fails      → pass the original error through
  │     └─ EXPIRED/REVOKED/CLOSED/MISSING
  │            → bank_sessions.ended_reason = "revoked"…  → 401 { code: "SESSION_ENDED" }
  │
  └─ (expiry by date needs no check: valid_until has passed → ended = "expired")
```

- **Why double-check?** A 401 also means **our own JWT** was rejected (e.g. a wrong key). Telling you to reconnect wouldn't help then, so the server only says "ended" once Enable Banking confirms it.
- **The client notices it anywhere.** Any request that gets `code: "SESSION_ENDED"` makes `main.tsx` refetch `/status` (and the account data, once). `/status` now says `{ connected: false, ended: "revoked", bank }`.
- **Read-only mode.** `App.tsx` shows a **"Reconnect your bank" banner** and keeps showing the accounts, chart, budgets and saved transactions. The server serves an ended session's accounts and **saved transactions without asking the bank**. Balances only ever come live, so they show "Balance not updated", and Refresh is hidden. Budgets are our own data, so they still work.
- **Reconnect Nordea** starts a login with the same bank. The new session replaces the ended one, and because saved data and budgets are filed under the stable account key (§4.6), everything is back. **Connect a different bank** is Disconnect, which shows the bank picker.

Code: [server/src/sessionEnded.ts](../server/src/sessionEnded.ts), [client/src/components/ReconnectBanner.tsx](../client/src/components/ReconnectBanner.tsx).

---

## 5. Data model (SQLite)

All SQL lives in [db.ts](../server/src/db.ts) and the three stores: [sessionStore.ts](../server/src/sessionStore.ts), [transactionStore.ts](../server/src/transactionStore.ts) and [budgetStore.ts](../server/src/budgetStore.ts). Switching to Postgres later means rewriting just those.

```
pending_auths                       bank_sessions
─────────────────────────           ─────────────────────────────
state         TEXT  PK              session_id    TEXT  PK
created_at    TEXT                  accounts      TEXT  (JSON array)
aspsp_name    TEXT  (bank)          valid_until   TEXT  (ISO date)
aspsp_country TEXT                  created_at    TEXT
                                    aspsp_name    TEXT  (bank)
                                    aspsp_country TEXT
                                    ended_reason  TEXT  (revoked, closed…)

transactions                        account_syncs
─────────────────────────           ─────────────────────────────
account_key     TEXT                account_key    TEXT  PK
date            TEXT  (YYYY-MM-DD)  covered_from   TEXT  (saved data starts)
status          TEXT  (BOOK, PDNG…) gap_from       TEXT  (nothing saved from…
entry_reference TEXT                gap_to         TEXT   …until, exclusive)
fingerprint     TEXT  (data's hash) last_synced_at TEXT  (ISO time)
saved_at        TEXT  (ISO time)    truncated      INTEGER (0/1)
data            TEXT  (bank's JSON) last_error     TEXT  (latest attempt failed)
                                    last_failed_at TEXT

budgets
─────────────────────────
account_key  TEXT  PK (with category)
category     TEXT  (e.g. groceries)
amount_cents INTEGER
```

- **`pending_auths`** holds logins that have started but not finished. A row is deleted when its callback arrives, or after 15 minutes.
- **`bank_sessions`** holds the current connection: at most one row. Once it has ended (`ended_reason` set, or `valid_until` passed), it stays until you reconnect or disconnect, so its accounts can still be shown read-only (§4.8).
- Dates are stored as ISO strings (`2026-11-01T13:00:00.000Z`). They're always written in that exact format, so comparing them as **text** gives the right order.
- **Migrations.** When a new version adds columns, `addColumnIfMissing()` adds them to an existing database without losing rows.

- **`transactions`** keeps each transaction exactly as the bank sent it (`data`), plus the few columns needed to find and replace it. `account_key` is the stable account id from §4.6, not the per-login `uid`.
- **`account_syncs`** has one row per account: when it was last synced, where the saved copy starts, any gap, and whether the latest attempt failed.
- **`budgets`** has one row per account and category: the monthly limit in cents (§4.7).

Balances are **not stored**. They're fetched live and cached for 5 minutes in the browser.

---

## 6. API reference (server)

| Method & path | What it does |
|---|---|
| `GET /api/auth/status` | `{ connected, ended, validUntil, bank, loginUrl }`; `ended` says why the connection can't be used any more ("expired", "revoked"…) |
| `DELETE /api/auth/session` | Disconnect: clears the sessions and revokes them at the bank |
| `GET /api/banks/countries` | Country codes this app is enabled for |
| `GET /api/banks?country=FI` | Banks in that country (name, logo, beta) |
| `GET /api/accounts` | The connected accounts |
| `GET /api/accounts/:uid/balances` | Balances for one account |
| `GET /api/accounts/:uid/transactions` | `{ transactions, dateFrom, dateTo, truncated, lastSyncedAt, syncError, gap }` from the saved copy; `?refresh=true` checks with the bank first |
| `GET /api/accounts/:uid/budgets` | `[{ category, amount }]` |
| `PUT /api/accounts/:uid/budgets/:category` | Body `{ amount }`: sets that category's monthly limit (400 if invalid) |
| `DELETE /api/accounts/:uid/budgets/:category` | Removes it (204) |
| `GET /login?bank=…&country=…` | *Browser navigation*, not fetch: starts a bank login |
| `GET /callback?code=…&state=…` | *The bank redirects here* after you approve |

Errors come back as JSON: `{ "error": "message" }`. Errors that come from Enable Banking keep their status code (e.g. 401, 429, 504). When the bank connection has ended, the error is `401 { "error": "…", "code": "SESSION_ENDED" }` (§4.8).

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
| Another website changing your budgets | Browsers only send a cross-site `PUT`/`DELETE` or JSON body after a CORS preflight, which only the client's origin passes. HTML forms can't send them, and non-JSON bodies aren't parsed, so they fail validation. |

**Not done yet:** user accounts and login. Before the app goes online, each user needs their own login and session (see §10).

---

## 8. Reliability design

- **Timeouts.** Every Enable Banking request gives up after **30 s**, and the 504 error is clear.
- **Readable failures.** Network errors become **502**, and HTML error pages from proxies keep their real status.
- **Retry policy (client).** Only network failures and 5xx errors are retried, at most twice. 4xx errors and malformed responses fail the same way every time, so they aren't retried; a retry of transactions can mean 20 bank calls.
- **Caching:**
  - In the browser, bank data is fresh for **5 minutes** and isn't refetched on every tab switch.
  - On the server, the bank list is cached for **1 hour**, and a failed fetch is not cached.
  - Transactions are saved in SQLite and re-synced with the bank after **15 minutes**, or on Refresh (§4.6).
- **Bank down.** Saved transactions are still shown, with a "Couldn't reach your bank" note.
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
| Saved transactions: replace the fetched range, don't match one by one | Works even when a bank sends no ids, and pending → booked needs no special case. | Each sync rewrites the last week or so of rows (cheap). |
| Login starts on the server (`/login`) | The cookie lands on the same host as `/callback`, so the CSRF protection works reliably. | The client needs `loginUrl` from `/status`. |

---

## 10. Known limitations and what's next

1. **No users or login.** It's one shared connection, and safe only because the server is loopback-only.
2. **No UI tests.** The logic is covered by automated tests (§11), but the React components aren't.
3. **Saved transactions are kept for 6 months and only deleted by age.** Disconnect keeps them (on purpose, see §4.6). An account you never reconnect keeps its last 6 months until you delete `server/data/`, and there's no "delete my data" button yet.
4. **Categories are automatic only.** You can't change a transaction's category or add your own rules from the app yet. Now that transactions are saved, that's the natural next step. There's no search or weekly view either.
5. **No warning before a connection expires.** Once it has ended, the app says so and offers reconnecting (§4.8), but it doesn't warn you a day or two in advance.

---

## 11. Testing

Run `npm test` in `server/` and in `client/`. GitHub Actions runs both on every push and pull request.

| Where | What it covers | How it fakes the outside world |
|---|---|---|
| `server/src/sessionStore.test.ts` | Single-use, expiring logins; replacing and revoking sessions; ended sessions (reason, expiry, not revoked again, replaced on reconnect) | In-memory SQLite (`DB_PATH=:memory:`) |
| `server/src/db.migration.test.ts` | An old-format database gains the new columns and keeps its session | A temporary database file with the old schema |
| `server/src/enableBankingClient.test.ts` | Timeouts, error pages, paging, the 89-day fallback rules, PSU headers, consent clamp | `fetch` replaced by a fake Enable Banking (`test/fakeBank.ts`) |
| `server/src/bankDirectory.test.ts` | Caching, failures not cached, bank lookup | Fake Enable Banking |
| `server/src/transactionStore.test.ts` | Replacing a range keeps older rows, pending → booked, unconfirmable pending dropped, moved dates, undated rows, truncated fetches never delete, pruning, gaps opening, filling and unchecked repairs, failures recorded | In-memory SQLite |
| `server/src/routes.test.ts` | The whole HTTP flow: `/login` guard, `/callback` state and cookie checks, account guard, error handling; saved transactions (no bank call while fresh, 7-day refresh, bank down and its 5-minute wait, 401/403 passed through, re-fetch after truncation and its unchecked part, reaching back to pending, one shared fetch for overlapping requests, gap after a long break and clipped to the window, history kept across reconnects); budgets (save, replace, remove, validation, kept across reconnects); ended connections (confirmed with Enable Banking before saying so, read-only saved data with no bank calls, reconnecting) | supertest calls `app` directly, without a real server |
| `client/src/lib/*.test.ts` | Summary maths, categories (real Nordea examples, totals match the chart), budgets (spent matches the breakdown, pace, status, sorting), formatting, API error and retry rules | `fetch` replaced in the API tests |

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
<code>server/src/db.ts</code>, <code>server/src/sessionStore.ts</code> and <code>server/src/transactionStore.ts</code>. All SQL is isolated there on purpose.
</details>

<details><summary>7. Why does the server listen only on loopback, and what would you need before changing that?</summary>
The API has no user login, so anyone who can reach it can read the bank data. Before exposing it, you need real user authentication (and HTTPS).
</details>

<details><summary>8. A transaction has status <code>PDNG</code>. Is it in the chart? In the table?</summary>
Not in the chart, where it's counted under "not settled yet". Yes in the table, with a "Pending" badge.
</details>

<details><summary>9. A card payment is saved as pending on Monday and booked on Wednesday. Why doesn't it show up twice after the next sync?</summary>
Each sync starts no later than the oldest saved pending transaction, so Monday is inside the range it fetches. Everything saved from that date on is deleted before the bank's fresh copy is inserted, so the pending row is removed and only the booked version goes back in. If the bank also sends the same <code>entry_reference</code> for both, that replaces it too, even when the dates differ.
</details>

<details><summary>10. Why are saved transactions filed under <code>identification_hash</code> and not the account <code>uid</code>?</summary>
The <code>uid</code> is new with every bank login. The hash comes from the account's IBAN and currency, so it stays the same after reconnecting, and the saved history is found again.
</details>

<details><summary>11. It's 10 October. You've spent €60 of a €100 Groceries budget. Is it "On track", "Spending fast" or "Over budget"?</summary>
"Spending fast". 10 of 31 days have gone by, so the pace is about 32%, and 60% is more than 10 points ahead of it. It isn't over budget, because €60 is less than €100. By 25 October (pace about 81%) the same €60 would be "On track".
</details>

<details><summary>12. The bank answers a balances request with 401. Why doesn't the server immediately tell you to reconnect?</summary>
A 401 can also mean Enable Banking rejected <b>our own JWT</b> (e.g. a wrong key), and reconnecting wouldn't fix that. So the server first asks Enable Banking for the session's state. Only if it's no longer <code>AUTHORIZED</code> does it record the session as ended and reply <code>SESSION_ENDED</code>; otherwise the original error comes through with its real message.
</details>
