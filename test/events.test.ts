import { expect, test } from "bun:test";
import type { WorkerEvent } from "../src/types";
import { Worker } from "../src/worker";
import { jobState, setup, waitFor } from "./helpers";

test("worker emits events in order for a completed job, a failed job, and a workflow step", async () => {
  const { sql, treadle } = await setup();
  const events: [WorkerEvent, string][] = [];
  const worker = new Worker(sql, {
    pollIntervalMs: 20,
    backoff: () => 10,
    onError: () => {},
    onEvent: (e, job) => events.push([e, job.name]),
  });
  worker.register("ok", async () => {});
  worker.register("bad", async () => { throw new Error("no"); });
  worker.registerWorkflow("wf", [{ name: "only", run: async () => 1 }]);
  const ok = await sql.begin((tx) => treadle.enqueue(tx, "ok", {}));
  const bad = await sql.begin((tx) => treadle.enqueue(tx, "bad", {}, { maxAttempts: 1 }));
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}));
  await worker.start();
  await waitFor(async () =>
    (await jobState(sql, ok)) === "completed" && (await jobState(sql, bad)) === "discarded" &&
    (await sql`select state from treadle.workflow_runs where id = ${runId}::bigint`)[0]?.state === "completed");
  await worker.stop();
  const of = (name: string) => events.filter((e) => e[1] === name).map((e) => e[0]);
  expect(of("ok")).toEqual(["claimed", "finishing", "completed"]);
  expect(of("bad")).toEqual(["claimed", "failed"]);
  expect(of("workflow:wf")).toEqual(["claimed", "stepFinished", "finishing", "completed"]);
  await sql.end();
});

test("an exception in onEvent is reported and does not affect the job", async () => {
  const { sql, treadle } = await setup();
  const errors: unknown[] = [];
  const worker = new Worker(sql, {
    pollIntervalMs: 20,
    onError: (e) => errors.push(e),
    onEvent: () => { throw new Error("listener bug"); },
  });
  worker.register("ok", async () => {});
  const id = await sql.begin((tx) => treadle.enqueue(tx, "ok", {}));
  await worker.start();
  await waitFor(async () => (await jobState(sql, id)) === "completed");
  await worker.stop();
  expect(errors.length).toBeGreaterThan(0);
  await sql.end();
});
