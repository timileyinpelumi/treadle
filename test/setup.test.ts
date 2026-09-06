import { expect, test } from "bun:test";
import { testSql } from "./setup";

test("test database is reachable and empty of treadle objects", async () => {
  const sql = await testSql();
  const [row] = await sql`select current_database() as db`;
  expect(row?.db).toBe("treadle_test");
  const schemas = await sql`select nspname from pg_namespace where nspname = 'treadle'`;
  expect(schemas.length).toBe(0);
  await sql.end();
});
