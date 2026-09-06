import { expect, test } from "bun:test";
import { Worker } from "../src/worker";
import { setup, waitFor } from "./helpers";

async function runState(sql: any, id: string): Promise<string> {
  const [r] = await sql`select state from treadle.workflow_runs where id = ${id}::bigint`;
  return r?.state;
}

test("steps run in order, each seeing the input and earlier results", async () => {
  const { sql, treadle } = await setup();
  const calls: string[] = [];
  const worker = new Worker(sql, { pollIntervalMs: 20 });
  worker.registerWorkflow("withdraw", [
    { name: "reserve", run: async (input: { amount: number }) => { calls.push("reserve"); return { holdId: `h-${input.amount}` }; } },
    { name: "send", run: async (input, results) => { calls.push("send"); return { ref: `${(results.reserve as any).holdId}-sent` }; } },
    { name: "settle", run: async (_input, results) => { calls.push("settle"); expect(results).toEqual({ reserve: { holdId: "h-5" }, send: { ref: "h-5-sent" } }); } },
  ]);
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "withdraw", { amount: 5 }));
  await worker.start();
  await waitFor(async () => (await runState(sql, runId)) === "completed");
  await worker.stop();
  expect(calls).toEqual(["reserve", "send", "settle"]);
  const results = await sql`select step_index, result from treadle.step_results where workflow_run_id = ${runId}::bigint order by step_index`;
  expect(results.map((r: any) => r.result)).toEqual([{ holdId: "h-5" }, { ref: "h-5-sent" }, null]);
  const [jobs] = await sql`select count(*)::int as n from treadle.jobs where state = 'completed'`;
  expect(jobs?.n).toBe(3);
  await sql.end();
});

test("a run resumes at the first step without a result", async () => {
  const { sql, treadle } = await setup();
  const calls: string[] = [];
  const worker = new Worker(sql, { pollIntervalMs: 20, rescueIntervalMs: 50 });
  worker.registerWorkflow("wf", [
    { name: "a", run: async () => { calls.push("a"); return 1; } },
    { name: "b", run: async () => { calls.push("b"); return 2; } },
    { name: "c", run: async (_i, results) => { calls.push("c"); return (results.a as number) + (results.b as number); } },
  ]);
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}));
  // Pretend steps a and b already ran and the process died after b's finishing
  // statement committed but before b's job was marked completed.
  await sql`insert into treadle.step_results (workflow_run_id, step_index, result) values (${runId}::bigint, 0, '1'::jsonb), (${runId}::bigint, 1, '2'::jsonb)`;
  await sql`update treadle.jobs set state = 'running', step_index = 1, idempotency_key = ${`wf:${runId}:1`}, worker_id = 'dead', lease_until = now() - interval '1 second', attempt = 1 where workflow_run_id = ${runId}::bigint`;
  await sql`insert into treadle.jobs (queue, name, args, workflow_run_id, step_index, idempotency_key) values ('default', 'workflow:wf', '{}', ${runId}::bigint, 2, ${`wf:${runId}:2`})`;
  await sql`update treadle.workflow_runs set current_step = 2 where id = ${runId}::bigint`;

  await worker.start();
  await waitFor(async () => (await runState(sql, runId)) === "completed");
  await worker.stop();
  expect(calls).toEqual(["c"]);
  const [jobs] = await sql`select count(*)::int as n from treadle.jobs where workflow_run_id = ${runId}::bigint`;
  expect(jobs?.n).toBe(2);
  const [c] = await sql`select result from treadle.step_results where workflow_run_id = ${runId}::bigint and step_index = 2`;
  expect(c?.result).toBe(3);
  await sql.end();
});

test("a failing step retries, then fails the run, and retry resumes it", async () => {
  const { sql, treadle } = await setup();
  let attempts = 0;
  let fixed = false;
  const worker = new Worker(sql, { pollIntervalMs: 20, backoff: () => 30, onError: () => {} });
  worker.registerWorkflow("wf", [
    { name: "ok", run: async () => "fine" },
    { name: "flaky", run: async () => { attempts++; if (!fixed) throw new Error("downstream down"); return "recovered"; } },
    { name: "after", run: async (_i, results) => results.flaky },
  ]);
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}, { maxAttempts: 2 }));
  await worker.start();
  await waitFor(async () => (await runState(sql, runId)) === "failed", 10_000);
  expect(attempts).toBe(2);
  const [job] = await sql`select id::text as id, state, last_error from treadle.jobs where workflow_run_id = ${runId}::bigint and step_index = 1`;
  expect(job?.state).toBe("discarded");
  expect(job?.last_error).toContain("downstream down");

  fixed = true;
  expect(await treadle.retry(job!.id)).toBe(true);
  await waitFor(async () => (await runState(sql, runId)) === "completed", 10_000);
  await worker.stop();
  const [after] = await sql`select result from treadle.step_results where workflow_run_id = ${runId}::bigint and step_index = 2`;
  expect(after?.result).toBe("recovered");
  await sql.end();
});

test("cancelWorkflow stops a run between steps", async () => {
  const { sql, treadle } = await setup();
  const calls: string[] = [];
  const worker = new Worker(sql, { pollIntervalMs: 20 });
  worker.registerWorkflow("wf", [
    { name: "a", run: async () => { calls.push("a"); await Bun.sleep(200); } },
    { name: "b", run: async () => { calls.push("b"); } },
  ]);
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}));
  await worker.start();
  await waitFor(async () => calls.includes("a"));
  expect(await treadle.cancelWorkflow(runId)).toBe(true);
  await waitFor(async () => (await runState(sql, runId)) === "cancelled", 3000);
  await Bun.sleep(300);
  await worker.stop();
  expect(calls).toEqual(["a"]);
  const [b] = await sql`select count(*)::int as n from treadle.jobs where workflow_run_id = ${runId}::bigint and step_index = 1 and state = 'available'`;
  expect(b?.n).toBe(0);
  await sql.end();
});

test("registerWorkflow rejects duplicate step names and empty workflows", async () => {
  const { sql } = await setup();
  const worker = new Worker(sql);
  expect(() => worker.registerWorkflow("wf", [])).toThrow("at least one step");
  expect(() => worker.registerWorkflow("wf", [{ name: "x", run: () => {} }, { name: "x", run: () => {} }])).toThrow("unique");
  await sql.end();
});
