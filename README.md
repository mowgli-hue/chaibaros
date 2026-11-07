# Chai Bar OS — franchise operations platform

Back office for The Chai Bar and its franchise network: every store, every channel, one
database. v1 = people and stock; Phase 2 = orders, menu, Clover feed, public API, reports.

## Phase 2 (orders & channels)

| Area | What works |
| --- | --- |
| Order Hub | One live board per store (New → Accepted → Preparing → Ready), tickets colour-tagged by channel, late-order colouring, item-level done, accept with ready time, cancel/refund with reason, counter order entry (POS-lite) with per-item tax, completed-today list and history. Auto-refreshes every 10 s. |
| Menu | Brand master menu (categories, items, modifier groups, tax class, station), per-store price overrides, sold-out toggle that propagates to App Thru / Vlink / Clover, per-channel hiding, recipes for auto-depletion. |
| Public API `/api/v1` | HMAC-signed (`X-Api-Key`, `X-Timestamp`, `X-Signature`): `POST /orders` (idempotent ingestion from App Thru / Vlink / TiffinGo / aggregator bridges), `GET /menu`, `GET /orders` (polling), `POST /orders/:id/status`. Outbound signed webhooks `order.*` with retries. |
| Clover | Connect a store with merchant id + API token, import its catalogue, sync paid orders into the hub (cursor-based), mirror sold-outs back to the register. `GET /api/cron?secret=` runs sync + webhook retries. |
| Customers | One record per phone across every channel/store, visits, lifetime value, consent with source. |
| Reports | Net sales, orders, direct vs aggregator share, commission paid, per-channel columns, royalty and ad-fund due per store (franchisor), CSV export, daily bars. Dashboard shows today / MTD / live orders per store. |
| Tax | Per province (BC GST 5% + PST 7% on `gst_pst` items; AB, SK, MB, ON, QC tables), computed once on the receipt totals. |

## v1 (people & stock)

| Area | What works |
| --- | --- |
| Franchise management | Brand → franchisee organizations → locations. Franchisor sees every store; owners see their org; managers/staff see their stores. Royalty % and ad-fund % on the brand (applied once the sales feed exists). "Add a franchisee" creates the org + first store and emails the owner an activation link. |
| Employee accounts | Email magic-link sign-in (no passwords). Invite by email with role + stores + hourly rate. Roles: franchisor, owner, manager, shift_lead, staff. 4–6 digit PIN for the shared store iPad. Deactivate kills the PIN instantly. Every sensitive change writes `audit_log`. |
| Scheduling | Week grid per store, draft → publish (emails each person their shifts), open-shift board with claims and manager approval, availability per person, BC Employment Standards checks (OT after 8h/day & 40h/week, 2× after 12h, 30-min break after 5h, 8h rest, overlaps, outside availability), live labour-cost estimate. |
| Time clock & timesheets | Clock in/out from phone (`/me`) or by PIN on the store iPad (`/schedule`). Bi-weekly timesheet with regular / OT 1.5× / OT 2× split, declared tips, manager edits with a reason (audited), CSV export for Wagepoint / QBO Payroll. |
| Inventory | Shared ingredient catalogue per franchisee, per-store stock + par levels, weekly count screen, receive / waste / adjust ledger with cost, reorder list, suppliers, stock-on-hand value. |
| Compliance | Required certificates per brand (business licence, health permit, FoodSafe, insurance…), per-store status matrix, expiring-in-30-days and expired flags on the dashboard. |

## Stack

Next.js 16 (App Router, server actions) · TypeScript · Tailwind v4 · Drizzle ORM · Postgres 16 · Auth.js v5 (Resend magic links) · Resend · date-fns · bcryptjs.

## Run locally

```bash
cp .env.example .env.local          # fill DATABASE_URL, AUTH_SECRET (openssl rand -base64 32)
npm install
npx drizzle-kit migrate             # creates all tables
OWNER_EMAIL=you@thechaibar.ca npx tsx scripts/seed.ts   # optional demo data: 3 stores, staff, stock
npm run dev
```

Dev reset: `DATABASE_URL=… ./scripts/reset-db.sh` (drops everything, migrates, seeds 4 stores, a chai menu and 14 days of orders).
The seed prints a demo App Thru API client: key `cb_demo_appthru`, secret `sk_demo_appthru_000…`.

## API quick reference

```
ts  = unix seconds
sig = HMAC_SHA256(secret, ts + "." + rawBody)      # GET: rawBody = ""
headers: X-Api-Key: <keyId>  X-Timestamp: <ts>  X-Signature: <sig>

POST /api/v1/orders                 body: see src/lib/orders.ts inboundOrderSchema (idempotency_key required)
GET  /api/v1/menu?location_id=      live menu with store prices + available flags (ETag)
GET  /api/v1/orders?location_id=&since=ISO&status=received,accepted
POST /api/v1/orders/{id}/status     {"status":"ready","ready_by":"ISO","note":"…"}
GET  /api/cron?secret=CRON_SECRET   every 2–5 min: Clover sync + webhook retries
```
Outbound webhooks: `POST <webhookUrl>` with `X-Chaibar-Signature = HMAC_SHA256(secret, body)`, events `order.received … order.refunded`.

With no `RESEND_API_KEY`, sign-in links and invites are printed to the terminal instead of emailed.
Sign in with the `OWNER_EMAIL` you seeded (franchisor + owner). Seeded store PIN for everyone: `1234`.

## Deploy (Railway + Vercel, or Railway only)

1. Railway: add a Postgres service; copy `DATABASE_URL`.
2. Set env vars: `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL` (your public URL), `RESEND_API_KEY`, `EMAIL_FROM` (verified domain in Resend), `APP_NAME`.
3. Run `npx drizzle-kit migrate` once against the production DB (Railway shell or a one-off job).
4. Deploy the Next app (Vercel or a Railway service running `npm run build && npm start`).
5. First person to sign in with no invite is sent to `/onboarding` to create the brand. After that, everyone else must be invited.

## Project layout

```
src/db/schema.ts        all tables + relations (tenancy, people, scheduling, inventory, compliance, audit)
src/auth.ts             Auth.js config (magic link, invite-gated sign-in)
src/lib/access.ts       who can see / manage what (viewer scope, role rank, assert helpers)
src/lib/rules.ts        BC scheduling rules + labour cost
src/actions/*.ts        server actions: staff, schedule, inventory, franchise, compliance, onboarding
src/app/(app)/*         pages: dashboard, brand, locations, staff, schedule, me, timesheets, inventory, compliance
scripts/seed.ts         demo data
drizzle/                SQL migrations
```

## Roadmap (same database)

Phase 2 ✅ order hub + menu + Clover feed + API → Phase 3 loyalty + daily close/cash + QBO journal → Phase 4 marketing engine (WhatsApp/SMS, segments, automations) → Phase 5 counter POS + Stripe Terminal + direct delivery-app APIs → Phase 6 multi-tenant billing for the franchise network. See the spec doc "Chai Bar OS — Custom Restaurant CRM & Operations Platform Spec".
