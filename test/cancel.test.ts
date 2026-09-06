import { expect, test } from "bun:test";
import { Worker } from "../src/worker";
import { jobState, setup, waitFor } from "./helpers";

test("cancel on an available or retryable job cancels it at once", async () => {
  const { sql, treadle } = await setup();
  const a = await sql.begin((tx) => treadle.enqueue(tx, "x", {}));
  const r = await sql.begin((tx) => treadle.enqueue(tx, "x", {}));
  await sql`update treadle.jobs set state = 'retryable' where id = ${r}`;
  expect(await treadle.cancel(a)).toBe(true);
  expect(await treadle.cancel(r)).toBe(true);
  expect(await jobState(sql, a)).toBe("cancelled");
  expect(await jobState(sql, r)).toBe("cancelled");
  const [row] = await sql`select finished_at from treadle.jobs where id = ${a}`;
  expect(row?.finished_at).not.toBeNull();
  await sql.end();
});

test("cancel on a finished job does nothing", async () => {
  const { sql, treadle } = await setup();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "x", {}));
  await sql`update treadle.jobs set state = 'completed' where id = ${id}`;
  expect(await treadle.cancel(id)).toBe(false);
  expect(await jobState(sql, id)).toBe("completed");
  expect(await treadle.cancel("999999")).toBe(false);
  await sql.end();
});

test("cancel on a running job aborts the signal and the job ends cancelled", async () => {
  const { sql, treadle } = await setup();
  const worker = new Worker(sql, { pollIntervalMs: 20, heartbeatMs: 50, onError: () => {} });
  let reason: string | null = null;
  worker.register("watch", async (_args, ctx) => {
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        reason = (ctx.signal.reason as Error).message;
        resolve();
      });
    });
  });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "watch", {}));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "running");
  expect(await treadle.cancel(id)).toBe(true);
  await waitFor(async () => (await jobState(sql, id)) === "cancelled");
  await worker.stop();
  expect(reason).toBe("cancelled");
  await sql.end();
});

test("retry resets a discarded or cancelled job and it runs again", async () => {
  const { sql, treadle } = await setup();
  const d = await sql.begin((tx) => treadle.enqueue(tx, "x", {}));
  const c = await sql.begin((tx) => treadle.enqueue(tx, "x", {}));
  const done = await sql.begin((tx) => treadle.enqueue(tx, "x", {}));
  await sql`update treadle.jobs set state = 'discarded', attempt = 5, finished_at = now(), last_error = 'old' where id = ${d}`;
  await sql`update treadle.jobs set state = 'cancelled', cancel_requested = true, finished_at = now() where id = ${c}`;
  await sql`update treadle.jobs set state = 'completed', finished_at = now() where id = ${done}`;

  expect(await treadle.retry(d)).toBe(true);
  expect(await treadle.retry(c)).toBe(true);
  expect(await treadle.retry(done)).toBe(false);

  const [row] = await sql`select state, attempt, cancel_requested, finished_at from treadle.jobs where id = ${d}`;
  expect(row?.state).toBe("available");
  expect(row?.attempt).toBe(0);
  expect(row?.cancel_requested).toBe(false);
  expect(row?.finished_at).toBeNull();

  const worker = new Worker(sql, { pollIntervalMs: 20 });
  worker.register("x", async () => {});
  await worker.start();
  await waitFor(async () => (await jobState(sql, d)) === "completed" && (await jobState(sql, c)) === "completed");
  await worker.stop();
  await sql.end();
});
