import { expect, test } from "bun:test";
import { Worker } from "../src/worker";
import { jobState, setup, waitFor } from "./helpers";

test("worker runs a registered handler and completes the job", async () => {
  const { sql, treadle } = await setup();
  const seen: unknown[] = [];
  const worker = new Worker(sql, { pollIntervalMs: 50 });
  worker.register("greet", async (args, ctx) => {
    seen.push({ args, attempt: ctx.attempt, name: ctx.name, queue: ctx.queue });
  });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "greet", { to: "you" }));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "completed");
  await worker.stop();

  expect(seen).toEqual([{ args: { to: "you" }, attempt: 1, name: "greet", queue: "default" }]);
  const [job] = await sql`select worker_id, lease_until, finished_at from treadle.jobs where id = ${id}`;
  expect(job?.worker_id).toBeNull();
  expect(job?.lease_until).toBeNull();
  expect(job?.finished_at).not.toBeNull();
  await sql.end();
});

test("worker leaves jobs it has no handler for, other queues, and future jobs alone", async () => {
  const { sql, treadle } = await setup();
  const worker = new Worker(sql, { pollIntervalMs: 50, queues: ["default"] });
  worker.register("known", async () => {});
  const known = await sql.begin((tx) => treadle.enqueue(tx, "known", {}));
  const unknown = await sql.begin((tx) => treadle.enqueue(tx, "unknown", {}));
  const other = await sql.begin((tx) => treadle.enqueue(tx, "known", {}, { queue: "other" }));
  const future = await sql.begin((tx) => treadle.enqueue(tx, "known", {}, { runAt: new Date(Date.now() + 60_000) }));
  await worker.start();
  await waitFor(async () => (await jobState(sql, known)) === "completed");
  await Bun.sleep(150);
  await worker.stop();
  expect(await jobState(sql, unknown)).toBe("available");
  expect(await jobState(sql, other)).toBe("available");
  expect(await jobState(sql, future)).toBe("available");
  await sql.end();
});

test("a failing handler moves the job to retryable with the error", async () => {
  const { sql, treadle } = await setup();
  const errors: unknown[] = [];
  const worker = new Worker(sql, { pollIntervalMs: 50, onError: (e) => errors.push(e) });
  worker.register("explode", async () => { throw new Error("kaboom"); });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "explode", {}));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "retryable");
  await worker.stop();
  const [job] = await sql`select last_error, attempt, worker_id, run_at from treadle.jobs where id = ${id}`;
  expect(job?.last_error).toContain("kaboom");
  expect(job?.attempt).toBe(1);
  expect(job?.worker_id).toBeNull();
  expect(new Date(job?.run_at).getTime()).toBeGreaterThan(Date.now() - 100);
  expect(errors.length).toBeGreaterThanOrEqual(1);
  await sql.end();
});

test("four workers and 200 jobs: every job completes exactly once", async () => {
  const { sql, treadle } = await setup();
  await sql`create table runs (job_id bigint not null)`;
  const workers = Array.from({ length: 4 }, () => {
    const w = new Worker(sql, { pollIntervalMs: 20, concurrency: 5 });
    w.register("work", async (_args, ctx) => {
      await sql`insert into runs (job_id) values (${ctx.jobId})`;
      await Bun.sleep(5);
    });
    return w;
  });
  await sql.begin(async (tx) => {
    for (let i = 0; i < 200; i++) await treadle.enqueue(tx, "work", { i });
  });
  await Promise.all(workers.map((w) => w.start()));
  await waitFor(async () => {
    const [row] = await sql`select count(*)::int as n from treadle.jobs where state = 'completed'`;
    return row?.n === 200;
  }, 20_000);
  await Promise.all(workers.map((w) => w.stop()));
  const [runs] = await sql`select count(*)::int as total, count(distinct job_id)::int as distinct_jobs from runs`;
  expect(runs?.total).toBe(200);
  expect(runs?.distinct_jobs).toBe(200);
  await sql.end();
});

test("worker respects concurrency", async () => {
  const { sql, treadle } = await setup();
  let active = 0;
  let peak = 0;
  const worker = new Worker(sql, { pollIntervalMs: 20, concurrency: 3 });
  worker.register("slow", async () => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(100);
    active--;
  });
  await sql.begin(async (tx) => {
    for (let i = 0; i < 12; i++) await treadle.enqueue(tx, "slow", {});
  });
  await worker.start();
  await waitFor(async () => {
    const [row] = await sql`select count(*)::int as n from treadle.jobs where state = 'completed'`;
    return row?.n === 12;
  }, 10_000);
  await worker.stop();
  expect(peak).toBe(3);
  await sql.end();
});
