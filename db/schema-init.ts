import { readFile } from "node:fs/promises";
import type { Sql } from "postgres";

/**
 * Fixed, app-wide advisory lock key. Every process that initializes the schema
 * (production migration and integration tests) takes the same transaction-scoped
 * lock, so concurrent `db/schema.sql` applications serialize instead of racing
 * on `create ... if not exists` (which is not concurrency-safe for indexes).
 */
const SCHEMA_INIT_LOCK_KEY = 1936287856; // 0x736c6f70 ("slop")

/**
 * Apply `db/schema.sql` exactly once per concurrent group.
 *
 * The whole script runs inside a single transaction that first acquires a
 * transaction-scoped advisory lock. The lock is released automatically on
 * commit/rollback, so a crashed initializer cannot wedge later runs. The schema
 * text is passed to `unsafe` as a single multi-statement string (never as a
 * bind parameter), preserving every additive statement.
 */
export async function initSchema(sql: Sql): Promise<void> {
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${SCHEMA_INIT_LOCK_KEY}::bigint)`;
    await tx.unsafe(schema);
  });
}
