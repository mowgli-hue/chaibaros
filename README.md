# Chai Bar OS — v1 (franchise management, staff, scheduling, inventory, compliance)

Back office for The Chai Bar and its franchise network. v1 is internal-only: no POS or
orders yet. The schema is built for the full roadmap (order hub, CRM, loyalty, marketing,
POS) so nothing here gets thrown away.

## What's in v1

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

Phase 2 order hub + KDS + Clover feed → Phase 3 customer CRM + loyalty + daily close → Phase 4 marketing engine → Phase 5 counter POS + Stripe Terminal + delivery apps → Phase 6 multi-tenant billing for the franchise network. See the spec doc "Chai Bar OS — Custom Restaurant CRM & Operations Platform Spec".
