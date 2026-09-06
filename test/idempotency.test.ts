import { expect, test } from "bun:test";
import { migrate } from "../src/migrate";
import { Treadle } from "../src/treadle";
import { testSql } from "./setup";

async function setup() {
  const sql = await testSql();
  await migrate(sql);
  return { sql, treadle: new Treadle(sql) };
}

test("a second enqueue with the same key returns the first id and inserts nothing", async () => {
  const { sql, treadle } = await setup();
  const a = await sql.begin((tx) => treadle.enqueue(tx, "settle", { id: 1 }, { idempotencyKey: "k1" }));
  const b = await sql.begin((tx) => treadle.enqueue(tx, "settle", { id: 2 }, { idempotencyKey: "k1" }));
  expect(b).toBe(a);
  const [row] = await sql`select count(*)::int as n from treadle.jobs`;
  expect(row?.n).toBe(1);
  const [job] = await sql`select args from treadle.jobs where id = ${a}`;
  expect(job?.args).toEqual({ id: 1 });
  await sql.end();
});

test("the key still deduplicates after the job is completed", async () => {
  const { sql, treadle } = await setup();
  const a = await sql.begin((tx) => treadle.enqueue(tx, "settle", {}, { idempotencyKey: "k2" }));
  await sql`update treadle.jobs set state = 'completed', finished_at = now() where id = ${a}`;
  const b = await sql.begin((tx) => treadle.enqueue(tx, "settle", {}, { idempotencyKey: "k2" }));
  expect(b).toBe(a);
  await sql.end();
});

test("different keys produce different jobs", async () => {
  const { sql, treadle } = await setup();
  const a = await sql.begin((tx) => treadle.enqueue(tx, "settle", {}, { idempotencyKey: "k3" }));
  const b = await sql.begin((tx) => treadle.enqueue(tx, "settle", {}, { idempotencyKey: "k4" }));
  expect(b).not.toBe(a);
  await sql.end();
});

test("a duplicate storm of 200 concurrent enqueues yields one row and one id", async () => {
  const { sql, treadle } = await setup();
  const ids = await Promise.all(
    Array.from({ length: 200 }, () =>
      sql.begin((tx) => treadle.enqueue(tx, "settle", {}, { idempotencyKey: "storm" })),
    ),
  );
  expect(new Set(ids).size).toBe(1);
  const [row] = await sql`select count(*)::int as n from treadle.jobs`;
  expect(row?.n).toBe(1);
  await sql.end();
});
