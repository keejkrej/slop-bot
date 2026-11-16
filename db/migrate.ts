import postgres from "postgres";
import { initSchema } from "./schema-init";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await initSchema(sql);
  console.log("Database schema is up to date.");
} finally {
  await sql.end();
}
