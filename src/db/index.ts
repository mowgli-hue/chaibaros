import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { conn?: postgres.Sql };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Reuse the connection in dev to avoid exhausting Postgres on hot reload.
const conn = globalForDb.conn ?? postgres(connectionString, { prepare: false, max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
export type Db = typeof db;
export { schema };
