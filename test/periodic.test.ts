import { expect, test } from "bun:test";
import { Worker } from "../src/worker";
import { jobState, setup, waitFor } from "./helpers";

test("a scheduled job runs once its run_at arrives", async () => {
  const { sql, treadle } = await setup();
  const worker = new Worker(sql, { pollIntervalMs: 20 });
  let ranAt = 0;
  worker.register("later", async () => { ranAt = Date.now(); });
  const due = Date.now() + 300;
  const id = await sql.begin((tx) => treadle.enqueue(tx, "later", {}, { runAt: new Date(due) }));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "completed", 3000);
  await worker.stop();
  expect(ranAt).toBeGreaterThanOrEqual(due - 5);
  await sql.end();
});

test("a periodic job keeps running as a chain of rows until cancelled", async () => {
  const { sql, treadle } = await setup();
  const worker = new Worker(sql, { pollIntervalMs: 20 });
  const runs: string[] = [];
  worker.register("tick", async (_args, ctx) => { runs.push(ctx.jobId); });
  await sql.begin((tx) => treadle.enqueue(tx, "tick", { n: 1 }, { every: 100 }));
  await worker.start();
  await waitFor(async () => runs.length >= 3, 3000);
  const [current] = await sql`select id::text as id from treadle.jobs where state = 'available' and name = 'tick'`;
  expect(await treadle.cancel(current!.id)).toBe(true);
  const count = runs.length;
  await Bun.sleep(400);
  await worker.stop();
  expect(runs.length).toBe(count);
  expect(new Set(runs).size).toBe(runs.length);
  const [rows] = await sql`select count(*)::int as n from treadle.jobs where name = 'tick' and state = 'available'`;
  expect(rows?.n).toBe(0);
  await sql.end();
});
