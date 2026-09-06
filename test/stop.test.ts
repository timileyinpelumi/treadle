import { expect, test } from "bun:test";
import { Worker } from "../src/worker";
import { jobState, setup, waitFor } from "./helpers";

test("stop waits for in-flight jobs to finish", async () => {
  const { sql, treadle } = await setup();
  const worker = new Worker(sql, { pollIntervalMs: 20 });
  let started = false;
  worker.register("slow", async () => { started = true; await Bun.sleep(400); });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "slow", {}));
  await worker.start();
  await waitFor(async () => started);
  const t0 = Date.now();
  await worker.stop();
  expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  expect(await jobState(sql, id)).toBe("completed");
  await sql.end();
});

test("stop gives up after stopTimeoutMs and leaves the job running with its lease", async () => {
  const { sql, treadle } = await setup();
  const worker = new Worker(sql, { pollIntervalMs: 20, stopTimeoutMs: 200 });
  let started = false;
  worker.register("stuck", async () => { started = true; await Bun.sleep(3000); });
  const id = await sql.begin((tx) => treadle.enqueue(tx, "stuck", {}));
  await worker.start();
  await waitFor(async () => started);
  const t0 = Date.now();
  await worker.stop();
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(await jobState(sql, id)).toBe("running");
  await sql.end();
});

test("stop does not claim new jobs once called", async () => {
  const { sql, treadle } = await setup();
  const worker = new Worker(sql, { pollIntervalMs: 20 });
  worker.register("noop", async () => {});
  await worker.start();
  await worker.stop();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "noop", {}));
  await Bun.sleep(100);
  expect(await jobState(sql, id)).toBe("available");
  await sql.end();
});
