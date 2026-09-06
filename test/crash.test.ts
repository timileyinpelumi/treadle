import { expect, test } from "bun:test";
import { Worker } from "../src/worker";
import { jobState, setup, waitFor } from "./helpers";
import { DATABASE_URL } from "./setup";

async function crashAt(point: string): Promise<number | null> {
  const child = Bun.spawn(["bun", "test/crash/child.ts"], {
    env: { ...process.env, DATABASE_URL, CRASH_AT: point },
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.signalCode === "SIGKILL" ? null : child.exitCode;
}

async function effects(sql: any): Promise<string[]> {
  return (await sql`select phase from crash_effects order by id`).map((r: any) => r.phase);
}

async function recover(sql: any): Promise<Worker> {
  const w = new Worker(sql, { pollIntervalMs: 20, leaseMs: 500, heartbeatMs: 100, rescueIntervalMs: 100, onError: () => {} });
  w.register("job", async (_a, ctx) => {
    await sql`insert into crash_effects (point, phase, job_id) values ('recovery', 'handler-start', ${ctx.jobId}::bigint)`;
    await sql`insert into crash_effects (point, phase, job_id) values ('recovery', 'handler-end', ${ctx.jobId}::bigint)`;
  });
  w.registerWorkflow("wf", [
    { name: "first", run: async (_i, _r, ctx) => { await sql`insert into crash_effects (point, phase, job_id) values ('recovery', 'step-first', ${ctx.jobId}::bigint)`; return { x: 1 }; } },
    { name: "second", run: async (_i, results, ctx) => { await sql`insert into crash_effects (point, phase, job_id) values ('recovery', 'step-second', ${ctx.jobId}::bigint)`; return results; } },
  ]);
  await w.start();
  return w;
}

async function prepare() {
  const { sql, treadle } = await setup();
  await sql`drop table if exists crash_effects`;
  await sql`create table crash_effects (id serial primary key, point text, phase text, job_id bigint)`;
  return { sql, treadle };
}

test("killed before claiming: the job is untouched and runs once on recovery", async () => {
  const { sql, treadle } = await prepare();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "job", {}));
  expect(await crashAt("before-claim")).toBeNull();
  expect(await jobState(sql, id)).toBe("available");
  const w = await recover(sql);
  await waitFor(async () => (await jobState(sql, id)) === "completed");
  await w.stop();
  expect(await effects(sql)).toEqual(["handler-start", "handler-end"]);
  const [job] = await sql`select attempt from treadle.jobs where id = ${id}`;
  expect(job?.attempt).toBe(1);
  await sql.end();
});

test("killed after claiming: the lease expires, the job is rescued, the handler runs once", async () => {
  const { sql, treadle } = await prepare();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "job", {}));
  expect(await crashAt("claimed")).toBeNull();
  const [orphan] = await sql`select state, worker_id, attempt from treadle.jobs where id = ${id}`;
  expect(orphan?.state).toBe("running");
  expect(orphan?.attempt).toBe(1);
  expect(await effects(sql)).toEqual([]);
  const w = await recover(sql);
  await waitFor(async () => (await jobState(sql, id)) === "completed", 5000);
  await w.stop();
  expect(await effects(sql)).toEqual(["handler-start", "handler-end"]);
  const [job] = await sql`select attempt, last_error from treadle.jobs where id = ${id}`;
  expect(job?.attempt).toBe(2);
  await sql.end();
});

test("killed mid-handler: the handler body runs again from the start", async () => {
  const { sql, treadle } = await prepare();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "job", {}));
  expect(await crashAt("mid-handler")).toBeNull();
  expect(await effects(sql)).toEqual(["handler-start"]);
  const w = await recover(sql);
  await waitFor(async () => (await jobState(sql, id)) === "completed", 5000);
  await w.stop();
  expect(await effects(sql)).toEqual(["handler-start", "handler-start", "handler-end"]);
  await sql.end();
});

test("killed after the handler but before completion: the side effect happens twice", async () => {
  const { sql, treadle } = await prepare();
  const id = await sql.begin((tx) => treadle.enqueue(tx, "job", {}));
  expect(await crashAt("finishing")).toBeNull();
  expect(await effects(sql)).toEqual(["handler-start", "handler-end"]);
  expect(await jobState(sql, id)).toBe("running");
  const w = await recover(sql);
  await waitFor(async () => (await jobState(sql, id)) === "completed", 5000);
  await w.stop();
  expect(await effects(sql)).toEqual(["handler-start", "handler-end", "handler-start", "handler-end"]);
  const [job] = await sql`select attempt from treadle.jobs where id = ${id}`;
  expect(job?.attempt).toBe(2);
  await sql.end();
});

test("killed after a step committed: the step is not re-run and the next step exists once", async () => {
  const { sql, treadle } = await prepare();
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}));
  expect(await crashAt("stepFinished")).toBeNull();
  expect(await effects(sql)).toEqual(["step-first"]);
  const [first] = await sql`select state from treadle.jobs where workflow_run_id = ${runId}::bigint and step_index = 0`;
  expect(first?.state).toBe("running");
  const [next] = await sql`select count(*)::int as n from treadle.jobs where workflow_run_id = ${runId}::bigint and step_index = 1`;
  expect(next?.n).toBe(1);

  const w = await recover(sql);
  await waitFor(async () => (await sql`select state from treadle.workflow_runs where id = ${runId}::bigint`)[0]?.state === "completed", 5000);
  await w.stop();
  expect(await effects(sql)).toEqual(["step-first", "step-second"]);
  const [jobs] = await sql`select count(*)::int as n from treadle.jobs where workflow_run_id = ${runId}::bigint`;
  expect(jobs?.n).toBe(2);
  const [second] = await sql`select result from treadle.step_results where workflow_run_id = ${runId}::bigint and step_index = 1`;
  expect(second?.result).toEqual({ first: { x: 1 } });
  await sql.end();
});
