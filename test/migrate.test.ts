import { expect, test } from "bun:test";
import { migrate } from "../src/migrate";
import { testSql } from "./setup";

test("migrate creates the treadle tables", async () => {
  const sql = await testSql();
  await migrate(sql);
  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'treadle' order by table_name`;
  expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual([
    "jobs", "migrations", "step_results", "workflow_runs",
  ]);
  await sql.end();
});

test("migrate creates the claim, rescue, and idempotency indexes", async () => {
  const sql = await testSql();
  await migrate(sql);
  const idx = await sql`
    select indexname from pg_indexes
    where schemaname = 'treadle' and tablename = 'jobs' order by indexname`;
  expect(idx.map((i: { indexname: string }) => i.indexname)).toEqual([
    "jobs_claim_idx", "jobs_idempotency_key_idx", "jobs_pkey", "jobs_rescue_idx",
  ]);
  await sql.end();
});

test("migrate twice applies nothing the second time", async () => {
  const sql = await testSql();
  await migrate(sql);
  await migrate(sql);
  const [row] = await sql`select count(*)::int as n from treadle.migrations`;
  expect(row?.n).toBe(1);
  await sql.end();
});
