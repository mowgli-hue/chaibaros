#!/usr/bin/env bash
# Dev only: drop and recreate the public schema, re-run migrations, seed.
set -e
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;"
npx drizzle-kit migrate
npx tsx scripts/seed.ts
