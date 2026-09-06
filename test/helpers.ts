import { migrate } from "../src/migrate";
import type { Sql } from "../src/sql";
import { Treadle } from "../src/treadle";
import { testSql } from "./setup";

export async function setup(): Promise<{ sql: Sql; treadle: Treadle }> {
  const sql = await testSql();
  await migrate(sql);
  return { sql, treadle: new Treadle(sql) };
}

export async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await Bun.sleep(25);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

export async function jobState(sql: Sql, id: string): Promise<string> {
  const [row] = await sql`select state from treadle.jobs where id = ${id}`;
  return row?.state as string;
}
