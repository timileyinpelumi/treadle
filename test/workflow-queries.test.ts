import { expect, test } from "bun:test";
import { claimJobs, completeJob, failJob, rescueExpired } from "../src/queries";
import { loadRun, stepDone, workflowJobName } from "../src/workflows";
import { setup } from "./helpers";

const base = { queues: ["default"], names: [workflowJobName("wf")], limit: 10, leaseMs: 30_000, workerId: "w1" };

test("startWorkflow creates a run and its first step job inside the transaction", async () => {
  const { sql, treadle } = await setup();
  const runId = await sql.begin((tx) =>
    treadle.startWorkflow(tx, "wf", { amount: 5 }, { queue: "ledger", priority: 2, maxAttempts: 3 }),
  );
  expect(typeof runId).toBe("string");
  const [run] = await sql`select name, input, state, current_step from treadle.workflow_runs where id = ${runId}`;
  expect(run?.name).toBe("wf");
  expect(run?.input).toEqual({ amount: 5 });
  expect(run?.state).toBe("running");
  expect(run?.current_step).toBe(0);
  const [job] = await sql`select name, queue, priority, max_attempts, workflow_run_id::text as run, step_index, idempotency_key, state from treadle.jobs`;
  expect(job?.name).toBe("workflow:wf");
  expect(job?.queue).toBe("ledger");
  expect(job?.priority).toBe(2);
  expect(job?.max_attempts).toBe(3);
  expect(job?.run).toBe(runId);
  expect(job?.step_index).toBe(0);
  expect(job?.idempotency_key).toBe(`wf:${runId}:0`);
  expect(job?.state).toBe("available");

  await expect(
    sql.begin(async (tx) => {
      await treadle.startWorkflow(tx, "wf", {});
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  const [n] = await sql`select count(*)::int as n from treadle.workflow_runs`;
  expect(n?.n).toBe(1);
  await sql.end();
});

test("startWorkflow with an idempotency key returns the existing run", async () => {
  const { sql, treadle } = await setup();
  const a = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", { n: 1 }, { idempotencyKey: "order:1" }));
  const b = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", { n: 2 }, { idempotencyKey: "order:1" }));
  expect(b).toBe(a);
  const [runs] = await sql`select count(*)::int as n from treadle.workflow_runs`;
  const [jobs] = await sql`select count(*)::int as n from treadle.jobs`;
  expect(runs?.n).toBe(1);
  expect(jobs?.n).toBe(1);
  await sql.end();
});

test("stepDone saves the result, enqueues the next step with the job's settings, and advances the run", async () => {
  const { sql, treadle } = await setup();
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}, { queue: "ledger", priority: 4, maxAttempts: 2 }));
  const [job] = await claimJobs(sql, { ...base, queues: ["ledger"] });
  await stepDone(sql, { runId, jobId: job!.id, stepIndex: 0, result: { hold: "h1" }, isLast: false });

  const loaded = await loadRun(sql, runId);
  expect(loaded?.results.get(0)).toEqual({ hold: "h1" });
  const [run] = await sql`select current_step, state from treadle.workflow_runs where id = ${runId}`;
  expect(run?.current_step).toBe(1);
  expect(run?.state).toBe("running");
  const [next] = await sql`select queue, priority, max_attempts, step_index, idempotency_key, state from treadle.jobs where step_index = 1`;
  expect(next?.queue).toBe("ledger");
  expect(next?.priority).toBe(4);
  expect(next?.max_attempts).toBe(2);
  expect(next?.idempotency_key).toBe(`wf:${runId}:1`);
  expect(next?.state).toBe("available");

  await stepDone(sql, { runId, jobId: job!.id, stepIndex: 0, result: { hold: "again" }, isLast: false });
  const [jobs] = await sql`select count(*)::int as n from treadle.jobs`;
  expect(jobs?.n).toBe(2);
  expect((await loadRun(sql, runId))?.results.get(0)).toEqual({ hold: "h1" });
  await sql.end();
});

test("stepDone on the last step completes the run and enqueues nothing", async () => {
  const { sql, treadle } = await setup();
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}));
  const [job] = await claimJobs(sql, base);
  await stepDone(sql, { runId, jobId: job!.id, stepIndex: 0, result: null, isLast: true });
  const [run] = await sql`select state, finished_at from treadle.workflow_runs where id = ${runId}`;
  expect(run?.state).toBe("completed");
  expect(run?.finished_at).not.toBeNull();
  const [jobs] = await sql`select count(*)::int as n from treadle.jobs`;
  expect(jobs?.n).toBe(1);
  await sql.end();
});

test("a discarded step job fails the run, a cancelled one cancels it, retry reopens it", async () => {
  const { sql, treadle } = await setup();
  const failed = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}, { maxAttempts: 1 }));
  const cancelled = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}));
  const rescued = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}, { maxAttempts: 1 }));
  const jobs = await claimJobs(sql, base);
  const byRun = Object.fromEntries(jobs.map((j) => [j.workflow_run_id, j.id]));

  expect(await failJob(sql, byRun[failed]!, "w1", "boom", 10)).toBe("discarded");
  await sql`update treadle.jobs set cancel_requested = true where id = ${byRun[cancelled]}`;
  expect(await completeJob(sql, byRun[cancelled]!, "w1")).toBe("cancelled");
  await sql`update treadle.jobs set lease_until = now() - interval '1 second' where id = ${byRun[rescued]}`;
  expect(await rescueExpired(sql)).toBe(1);

  const states = Object.fromEntries(
    (await sql`select id::text as id, state from treadle.workflow_runs`).map((r: { id: string; state: string }) => [r.id, r.state]),
  );
  expect(states[failed]).toBe("failed");
  expect(states[cancelled]).toBe("cancelled");
  expect(states[rescued]).toBe("failed");

  expect(await treadle.retry(byRun[failed]!)).toBe(true);
  const [run] = await sql`select state, finished_at from treadle.workflow_runs where id = ${failed}`;
  expect(run?.state).toBe("running");
  expect(run?.finished_at).toBeNull();
  await sql.end();
});
