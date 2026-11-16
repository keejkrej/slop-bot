import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSchema } from "../db/schema-init";

/**
 * Regression for concurrent schema application. Without the advisory lock,
 * parallel `create ... if not exists` statements (notably unique indexes) can
 * fail with duplicate pg_type errors. Runs only when TEST_DATABASE_URL is set.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("schema init concurrency (integration)", () => {
  let clients: import("postgres").Sql[] = [];

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    clients = Array.from({ length: 8 }, () => postgres(url!, { max: 1 }));
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
  });

  it("serializes concurrent schema application without duplicate index errors", async () => {
    // Drop one index so concurrent `create index if not exists` would race
    // without the transaction-scoped advisory lock. initSchema restores it.
    await clients[0]`drop index if exists messages_user_sender_created_idx`;

    const results = await Promise.allSettled(clients.map((client) => initSchema(client)));
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toEqual([]);

    const [row] = await clients[0]`
      select 1 from pg_indexes where indexname = 'messages_user_sender_created_idx'
    `;
    expect(row).toBeTruthy();
  });
});
