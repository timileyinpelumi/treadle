import { expect, test } from "bun:test";
import { Worker } from "../src/worker";
import { jobState, setup, waitFor } from "./helpers";

test("worker retries with the configured backoff and discards after max attempts", async () => {
  const { sql, treadle } = await setup();
  const attemptsSeen: number[] = [];
  const worker = new Worker(sql, {
    pollIntervalMs: 20,
    backoff: (attempt) => attempt * 100,
    onError: () => {},
  });
  worker.register("flaky", async (_args, ctx) => {
    attemptsSeen.push(ctx.attempt);
    throw new Error(`attempt ${ctx.attempt}`);
  });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "flaky", {}, { maxAttempts: 3 }));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "discarded", 10_000);
  await worker.stop();
  expect(attemptsSeen).toEqual([1, 2, 3]);
  const [job] = await sql`select last_error, finished_at from treadle.jobs where id = ${id}`;
  expect(job?.last_error).toContain("attempt 3");
  expect(job?.finished_at).not.toBeNull();
  await sql.end();
});

test("a retryable job is not claimed before its run_at", async () => {
  const { sql, treadle } = await setup();
  const times: number[] = [];
  const worker = new Worker(sql, { pollIntervalMs: 20, backoff: () => 400, onError: () => {} });
  worker.register("once", async () => {
    times.push(Date.now());
    if (times.length === 1) throw new Error("first fails");
  });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "once", {}));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "completed", 5000);
  await worker.stop();
  expect(times.length).toBe(2);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(380);
  await sql.end();
});
