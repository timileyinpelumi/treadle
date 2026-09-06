import { expect, test } from "bun:test";
import { overview, recentFailures, workflowRun, workflowRuns } from "../src/dashboard-queries";
import { setup } from "./helpers";

test("overview counts jobs per queue and state and per minute for the last hour", async () => {
  const { sql, treadle } = await setup();
  await sql.begin(async (tx) => {
    await treadle.enqueue(tx, "a", {});
    await treadle.enqueue(tx, "a", {}, { queue: "ledger" });
    await treadle.enqueue(tx, "a", {}, { queue: "ledger" });
  });
  await sql`update treadle.jobs set state = 'completed', finished_at = now() where queue = 'ledger'`;
  await sql`insert into treadle.jobs (name, state, finished_at, last_error) values ('a', 'discarded', now() - interval '2 hours', 'old')`;
  const o = await overview(sql);
  expect(o.counts).toEqual([
    { queue: "default", state: "available", n: 1 },
    { queue: "default", state: "discarded", n: 1 },
    { queue: "ledger", state: "completed", n: 2 },
  ]);
  expect(o.perMinute.length).toBe(1);
  expect(o.perMinute[0]?.state).toBe("completed");
  expect(o.perMinute[0]?.n).toBe(2);
  await sql.end();
});

test("recentFailures lists retryable and discarded jobs with errors, newest first", async () => {
  const { sql, treadle } = await setup();
  const a = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  const b = await sql.begin((tx) => treadle.enqueue(tx, "b", {}));
  await sql.begin((tx) => treadle.enqueue(tx, "c", {}));
  await sql`update treadle.jobs set state = 'discarded', last_error = 'gave up', attempt = 3, finished_at = now() - interval '1 minute' where id = ${a}`;
  await sql`update treadle.jobs set state = 'retryable', last_error = 'try again', attempt = 1, run_at = now() + interval '1 minute' where id = ${b}`;
  const rows = await recentFailures(sql);
  expect(rows.map((r) => r.id)).toEqual([b, a]);
  expect(rows[0]?.last_error).toBe("try again");
  expect(rows[1]?.attempt).toBe(3);
  await sql.end();
});

test("workflowRuns and workflowRun show runs and their steps", async () => {
  const { sql, treadle } = await setup();
  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", { n: 1 }));
  await sql`insert into treadle.step_results (workflow_run_id, step_index, result) values (${runId}::bigint, 0, '{"ok":true}'::jsonb)`;
  await sql`update treadle.jobs set state = 'completed', finished_at = now() where workflow_run_id = ${runId}::bigint`;
  await sql`insert into treadle.jobs (name, workflow_run_id, step_index, state, attempt, last_error) values ('workflow:wf', ${runId}::bigint, 1, 'retryable', 2, 'boom')`;
  await sql`update treadle.workflow_runs set current_step = 1 where id = ${runId}::bigint`;

  const runs = await workflowRuns(sql);
  expect(runs.length).toBe(1);
  expect(runs[0]?.id).toBe(runId);
  expect(runs[0]?.current_step).toBe(1);

  const detail = await workflowRun(sql, runId);
  expect(detail?.run.name).toBe("wf");
  expect(detail?.run.input).toEqual({ n: 1 });
  expect(detail?.steps.map((s) => [s.step_index, s.state, s.has_result])).toEqual([[0, "completed", true], [1, "retryable", false]]);
  expect(detail?.steps[0]?.result).toEqual({ ok: true });
  expect(detail?.steps[1]?.last_error).toBe("boom");
  expect(await workflowRun(sql, "999999")).toBeNull();
  await sql.end();
});
