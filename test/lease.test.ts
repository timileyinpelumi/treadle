import { expect, test } from "bun:test";
import { rescueExpired } from "../src/queries";
import { Worker } from "../src/worker";
import { jobState, setup, waitFor } from "./helpers";

test("heartbeat keeps a long job alive past its lease", async () => {
  const { sql, treadle } = await setup();
  const worker = new Worker(sql, { pollIntervalMs: 20, leaseMs: 300, heartbeatMs: 100, rescueIntervalMs: 100 });
  worker.register("long", async () => { await Bun.sleep(900); });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "long", {}));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "completed", 5000);
  await worker.stop();
  const [job] = await sql`select attempt, last_error from treadle.jobs where id = ${id}`;
  expect(job?.attempt).toBe(1);
  expect(job?.last_error).toBeNull();
  await sql.end();
});

test("a job whose worker died is rescued and finished by a live worker", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "work", {}));
  await sql`update treadle.jobs set state = 'running', attempt = 1, worker_id = 'dead', lease_until = now() - interval '1 second' where id = ${id}`;
  const worker = new Worker(sql, { pollIntervalMs: 20, rescueIntervalMs: 50 });
  worker.register("work", async () => {});
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "completed");
  await worker.stop();
  const [job] = await sql`select attempt from treadle.jobs where id = ${id}`;
  expect(job?.attempt).toBe(2);
  await sql.end();
});

test("a worker that lost its lease cannot complete the job and is told so", async () => {
  const { sql, treadle } = await setup();
  const errors: string[] = [];
  const worker = new Worker(sql, {
    pollIntervalMs: 20,
    leaseMs: 200,
    heartbeatMs: 60_000,
    rescueIntervalMs: 60_000,
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
  });
  let aborted = false;
  worker.register("slow", async (_args, ctx) => {
    await Bun.sleep(600);
    aborted = ctx.signal.aborted;
  });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "slow", {}));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "running");
  await Bun.sleep(300);
  expect(await rescueExpired(sql)).toBe(1);
  await sql`update treadle.jobs set state = 'running', worker_id = 'other', lease_until = now() + interval '1 minute' where id = ${id}`;
  await Bun.sleep(500);
  await worker.stop();
  const [job] = await sql`select state, worker_id from treadle.jobs where id = ${id}`;
  expect(job?.state).toBe("running");
  expect(job?.worker_id).toBe("other");
  expect(errors).toContain("lease lost before completion");
  expect(aborted).toBe(false);
  await sql.end();
});
