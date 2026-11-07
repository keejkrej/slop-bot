import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await sql.unsafe(schema);
  console.log("Database schema is up to date.");
} finally {
  await sql.end();
}
