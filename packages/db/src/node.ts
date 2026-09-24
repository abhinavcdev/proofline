import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { DrizzleStore } from "./store.js";

/** Node-only helpers (filesystem migrations). Workers import `DrizzleStore` from the main entry. */

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** In-process Postgres (PGlite). `dataDir` omitted = in-memory. */
export async function createPgliteStore(dataDir?: string): Promise<{ store: DrizzleStore; close: () => Promise<void> }> {
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client);
  await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { store: new DrizzleStore(db), close: () => client.close() };
}

export async function createPostgresStore(
  url: string,
  opts: { migrate?: boolean } = {},
): Promise<{ store: DrizzleStore; close: () => Promise<void> }> {
  const client = postgres(url, { max: 10, prepare: false });
  const db = drizzlePostgres(client);
  if (opts.migrate) await migratePostgres(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { store: new DrizzleStore(db), close: () => client.end() };
}
