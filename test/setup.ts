import { SQL } from "bun";

const DEFAULT_URL = "postgres://postgres:postgres@127.0.0.1:5432/treadle_test";

export const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_URL;

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

function dbName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

let created = false;

async function ensureDatabase(): Promise<void> {
  if (created) return;
  const admin = new SQL(adminUrl(DATABASE_URL));
  const name = dbName(DATABASE_URL);
  const rows = await admin`select 1 from pg_database where datname = ${name}`;
  if (rows.length === 0) {
    // Identifiers cannot be bound as parameters. name comes from our own URL.
    await admin.unsafe(`create database "${name}"`);
  }
  await admin.end();
  created = true;
}

export async function testSql(): Promise<SQL> {
  await ensureDatabase();
  const sql = new SQL(DATABASE_URL);
  await sql`drop schema if exists treadle cascade`;
  return sql;
}
