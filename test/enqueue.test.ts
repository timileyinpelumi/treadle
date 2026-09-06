import { expect, test } from "bun:test";
import { migrate } from "../src/migrate";
import { Treadle } from "../src/treadle";
import { testSql } from "./setup";

async function setup() {
  const sql = await testSql();
  await migrate(sql);
  return { sql, treadle: new Treadle(sql) };
}

test("enqueue inside a committed transaction persists the job with defaults", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "send-email", { to: "a@b.c" }));
  expect(typeof id).toBe("string");
  const [job] = await sql`select * from treadle.jobs where id = ${id}`;
  expect(job?.name).toBe("send-email");
  expect(job?.args).toEqual({ to: "a@b.c" });
  expect(job?.queue).toBe("default");
  expect(job?.state).toBe("available");
  expect(job?.priority).toBe(0);
  expect(job?.attempt).toBe(0);
  expect(job?.max_attempts).toBe(25);
  expect(job?.idempotency_key).toBeNull();
  expect(job?.every_ms).toBeNull();
  await sql.end();
});

test("enqueue inside a rolled back transaction leaves no job", async () => {
  const { sql, treadle } = await setup();
  await expect(
    sql.begin(async (tx) => {
      await treadle.enqueue(tx, "send-email", {});
      throw new Error("business write failed");
    }),
  ).rejects.toThrow("business write failed");
  const [row] = await sql`select count(*)::int as n from treadle.jobs`;
  expect(row?.n).toBe(0);
  await sql.end();
});

test("enqueue persists every option", async () => {
  const { sql, treadle } = await setup();
  const runAt = new Date(Date.now() + 60_000);
  const id = await sql.begin((tx) =>
    treadle.enqueue(tx, "settle", { id: 7 }, {
      queue: "ledger",
      priority: 3,
      runAt,
      maxAttempts: 5,
      idempotencyKey: "settle:7",
      every: 60_000,
    }),
  );
  const [job] = await sql`select * from treadle.jobs where id = ${id}`;
  expect(job?.queue).toBe("ledger");
  expect(job?.priority).toBe(3);
  expect(new Date(job?.run_at).getTime()).toBe(runAt.getTime());
  expect(job?.max_attempts).toBe(5);
  expect(job?.idempotency_key).toBe("settle:7");
  expect(job?.every_ms).toBe(60_000);
  await sql.end();
});

test("enqueue rejects an empty name and bad numbers", async () => {
  const { sql, treadle } = await setup();
  await expect(sql.begin((tx) => treadle.enqueue(tx, "", {}))).rejects.toThrow("name");
  await expect(sql.begin((tx) => treadle.enqueue(tx, "x", 42))).rejects.toThrow("args");
  await expect(
    sql.begin((tx) => treadle.enqueue(tx, "x", {}, { maxAttempts: 0 })),
  ).rejects.toThrow("maxAttempts");
  await expect(
    sql.begin((tx) => treadle.enqueue(tx, "x", {}, { every: 0 })),
  ).rejects.toThrow("every");
  await sql.end();
});
