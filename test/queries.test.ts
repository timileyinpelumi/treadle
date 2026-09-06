import { expect, test } from "bun:test";
import { claimJobs, completeJob, extendLease, failJob, rescueExpired } from "../src/queries";
import { setup } from "./helpers";

const base = { queues: ["default"], names: ["a"], limit: 10, leaseMs: 30_000, workerId: "w1" };

test("claimJobs takes available jobs, marks them running with a lease, and skips others", async () => {
  const { sql, treadle } = await setup();
  const ready = await sql.begin((tx) => treadle.enqueue(tx, "a", { n: 1 }));
  await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { runAt: new Date(Date.now() + 60_000) }));
  await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { queue: "other" }));
  await sql.begin((tx) => treadle.enqueue(tx, "b", {}));

  const jobs = await claimJobs(sql, base);
  expect(jobs.map((j) => j.id)).toEqual([ready]);
  expect(jobs[0]?.state).toBe("running");
  expect(jobs[0]?.attempt).toBe(1);
  expect(jobs[0]?.worker_id).toBe("w1");
  expect(jobs[0]?.args).toEqual({ n: 1 });
  expect(new Date(jobs[0]!.lease_until!).getTime()).toBeGreaterThan(Date.now() + 20_000);

  expect(await claimJobs(sql, base)).toEqual([]);
  await sql.end();
});

test("claimJobs orders by priority then run_at and honours limit", async () => {
  const { sql, treadle } = await setup();
  const late = await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { priority: 5 }));
  const first = await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { priority: 0, runAt: new Date(Date.now() - 2000) }));
  const second = await sql.begin((tx) => treadle.enqueue(tx, "a", {}, { priority: 0, runAt: new Date(Date.now() - 1000) }));

  const jobs = await claimJobs(sql, { ...base, limit: 2 });
  expect(jobs.map((j) => j.id)).toEqual([first, second]);
  const rest = await claimJobs(sql, base);
  expect(rest.map((j) => j.id)).toEqual([late]);
  await sql.end();
});

test("claimJobs takes retryable jobs once run_at has passed", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await sql`update treadle.jobs set state = 'retryable', attempt = 1 where id = ${id}`;
  const jobs = await claimJobs(sql, base);
  expect(jobs.map((j) => j.id)).toEqual([id]);
  expect(jobs[0]?.attempt).toBe(2);
  await sql.end();
});

test("completeJob and failJob only apply to the worker holding the lease", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await claimJobs(sql, base);

  expect(await completeJob(sql, id, "someone-else")).toBe(false);
  expect(await completeJob(sql, id, "w1")).toBe(true);
  const [done] = await sql`select state, worker_id, lease_until, finished_at from treadle.jobs where id = ${id}`;
  expect(done?.state).toBe("completed");
  expect(done?.worker_id).toBeNull();
  expect(done?.lease_until).toBeNull();
  expect(done?.finished_at).not.toBeNull();

  const id2 = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await claimJobs(sql, base);
  const later = new Date(Date.now() + 1000);
  expect(await failJob(sql, id2, "w1", "boom", later)).toBe(true);
  const [failed] = await sql`select state, last_error, run_at, worker_id from treadle.jobs where id = ${id2}`;
  expect(failed?.state).toBe("retryable");
  expect(failed?.last_error).toBe("boom");
  expect(new Date(failed?.run_at).getTime()).toBe(later.getTime());
  expect(failed?.worker_id).toBeNull();
  await sql.end();
});

test("extendLease moves lease_until forward for the holder only", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  const [job] = await claimJobs(sql, { ...base, leaseMs: 1000 });
  const before = new Date(job!.lease_until!).getTime();
  expect(await extendLease(sql, id, "w1", 60_000)).toBe(true);
  const [row] = await sql`select lease_until from treadle.jobs where id = ${id}`;
  expect(new Date(row?.lease_until).getTime()).toBeGreaterThan(before + 30_000);
  expect(await extendLease(sql, id, "w2", 60_000)).toBe(false);
  await sql.end();
});

test("rescueExpired returns expired running jobs to retryable and leaves live ones", async () => {
  const { sql, treadle } = await setup();
  const dead = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  const live = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await sql`update treadle.jobs set state = 'running', worker_id = 'gone', lease_until = now() - interval '1 second' where id = ${dead}`;
  await sql`update treadle.jobs set state = 'running', worker_id = 'alive', lease_until = now() + interval '1 minute' where id = ${live}`;

  expect(await rescueExpired(sql)).toBe(1);
  const [d] = await sql`select state, worker_id, lease_until, last_error from treadle.jobs where id = ${dead}`;
  expect(d?.state).toBe("retryable");
  expect(d?.worker_id).toBeNull();
  expect(d?.lease_until).toBeNull();
  expect(d?.last_error).toBe("lease expired");
  const [l] = await sql`select state from treadle.jobs where id = ${live}`;
  expect(l?.state).toBe("running");
  await sql.end();
});
