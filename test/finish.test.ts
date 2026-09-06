import { expect, test } from "bun:test";
import { claimJobs, completeJob, extendLease, failJob, rescueExpired } from "../src/queries";
import { setup } from "./helpers";

const base = { queues: ["default"], names: ["a"], limit: 10, leaseMs: 30_000, workerId: "w1" };

test("failJob discards when attempt has reached max_attempts", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { maxAttempts: 2 }));
  await claimJobs(sql, base);
  expect(await failJob(sql, id, "w1", "first", 10)).toBe("retryable");
  await sql`update treadle.jobs set run_at = now() where id = ${id}`;
  await claimJobs(sql, base);
  expect(await failJob(sql, id, "w1", "second", 10)).toBe("discarded");
  const [job] = await sql`select state, attempt, last_error, finished_at from treadle.jobs where id = ${id}`;
  expect(job?.state).toBe("discarded");
  expect(job?.attempt).toBe(2);
  expect(job?.last_error).toBe("second");
  expect(job?.finished_at).not.toBeNull();
  await sql.end();
});

test("failJob and completeJob map to cancelled when cancel was requested", async () => {
  const { sql, treadle } = await setup();
  const a = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  const b = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await claimJobs(sql, base);
  await sql`update treadle.jobs set cancel_requested = true where id in (${a}, ${b})`;
  expect(await failJob(sql, a, "w1", "boom", 10)).toBe("cancelled");
  expect(await completeJob(sql, b, "w1")).toBe("cancelled");
  const rows = await sql`select state, finished_at from treadle.jobs where id in (${a}, ${b})`;
  expect(rows.every((r: { state: string; finished_at: Date | null }) => r.state === "cancelled" && r.finished_at !== null)).toBe(true);
  await sql.end();
});

test("extendLease reports a cancel request", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await claimJobs(sql, base);
  await sql`update treadle.jobs set cancel_requested = true where id = ${id}`;
  expect(await extendLease(sql, id, "w1", 1000)).toEqual({ held: true, cancelRequested: true });
  await sql.end();
});

test("rescueExpired discards exhausted jobs and cancels requested ones", async () => {
  const { sql, treadle } = await setup();
  const exhausted = await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { maxAttempts: 1 }));
  const cancelled = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  const fresh = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await sql`update treadle.jobs set state = 'running', attempt = 1, worker_id = 'gone', lease_until = now() - interval '1 second' where id in (${exhausted}, ${cancelled}, ${fresh})`;
  await sql`update treadle.jobs set cancel_requested = true where id = ${cancelled}`;
  expect(await rescueExpired(sql)).toBe(3);
  const states = Object.fromEntries(
    (await sql`select id::text as id, state from treadle.jobs`).map((r: { id: string; state: string }) => [r.id, r.state]),
  );
  expect(states[exhausted]).toBe("discarded");
  expect(states[cancelled]).toBe("cancelled");
  expect(states[fresh]).toBe("retryable");
  await sql.end();
});

test("a periodic job re-enqueues itself on completion with run_at advanced", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) =>
    treadle.enqueue(tx, "a", { tick: true }, { every: 5000, priority: 2, maxAttempts: 3, idempotencyKey: "tick" }),
  );
  await claimJobs(sql, base);
  expect(await completeJob(sql, id, "w1")).toBe("completed");
  const rows = await sql`select id::text as id, state, args, priority, max_attempts, every_ms, idempotency_key, run_at from treadle.jobs order by id`;
  expect(rows.length).toBe(2);
  const next = rows[1];
  expect(next.state).toBe("available");
  expect(next.args).toEqual({ tick: true });
  expect(next.priority).toBe(2);
  expect(next.max_attempts).toBe(3);
  expect(next.every_ms).toBe(5000);
  expect(next.idempotency_key).toBeNull();
  expect(new Date(next.run_at).getTime()).toBeGreaterThan(Date.now() + 4000);
  await sql.end();
});

test("a periodic job re-enqueues on discard but not on cancel", async () => {
  const { sql, treadle } = await setup();
  const d = await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { every: 5000, maxAttempts: 1 }));
  const c = await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { every: 5000 }));
  await claimJobs(sql, base);
  await sql`update treadle.jobs set cancel_requested = true where id = ${c}`;
  expect(await failJob(sql, d, "w1", "boom", 10)).toBe("discarded");
  expect(await completeJob(sql, c, "w1")).toBe("cancelled");
  const [row] = await sql`select count(*)::int as n from treadle.jobs where state = 'available'`;
  expect(row?.n).toBe(1);
  await sql.end();
});
