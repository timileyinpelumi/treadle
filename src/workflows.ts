import type { Sql } from "./sql";
import type { StartWorkflowOptions } from "./types";

export function workflowJobName(name: string): string {
  return `workflow:${name}`;
}

export function stepKey(runId: string, stepIndex: number): string {
  return `wf:${runId}:${stepIndex}`;
}

export async function startWorkflowRun(
  tx: Sql,
  name: string,
  input: unknown,
  options: StartWorkflowOptions,
): Promise<string> {
  if (options.idempotencyKey) {
    const existing = await tx`
      select workflow_run_id::text as run from treadle.jobs
      where idempotency_key = ${options.idempotencyKey}`;
    if (existing[0]) return existing[0].run as string;
  }
  const [run] = await tx`
    insert into treadle.workflow_runs (name, input)
    values (${name}, ${input ?? {}}::jsonb)
    returning id::text as id`;
  const runId = run!.id as string;
  const rows = await tx`
    insert into treadle.jobs
      (queue, name, args, priority, max_attempts, workflow_run_id, step_index, idempotency_key)
    values (${options.queue ?? "default"}, ${workflowJobName(name)}, '{}'::jsonb,
            ${options.priority ?? 0}, ${options.maxAttempts ?? 25}, ${runId}::bigint, 0,
            ${options.idempotencyKey ?? stepKey(runId, 0)})
    on conflict (idempotency_key) where idempotency_key is not null do nothing
    returning id`;
  if (rows.length === 0) {
    // Lost a race on the idempotency key between the select above and this insert.
    await tx`delete from treadle.workflow_runs where id = ${runId}::bigint`;
    const [winner] = await tx`
      select workflow_run_id::text as run from treadle.jobs
      where idempotency_key = ${options.idempotencyKey!}`;
    return winner!.run as string;
  }
  return runId;
}

export async function loadRun(
  sql: Sql,
  runId: string,
): Promise<{ input: unknown; state: string; results: Map<number, unknown> } | null> {
  const [run] = await sql`select input, state from treadle.workflow_runs where id = ${runId}::bigint`;
  if (!run) return null;
  const rows = await sql`
    select step_index, result from treadle.step_results
    where workflow_run_id = ${runId}::bigint order by step_index`;
  const results = new Map<number, unknown>();
  for (const r of rows as { step_index: number; result: unknown }[]) results.set(r.step_index, r.result);
  return { input: run.input, state: run.state as string, results };
}

export async function stepDone(
  sql: Sql,
  args: { runId: string; jobId: string; stepIndex: number; result: unknown; isLast: boolean },
): Promise<void> {
  const next = args.stepIndex + 1;
  await sql`
    with saved as (
      insert into treadle.step_results (workflow_run_id, step_index, result)
      values (${args.runId}::bigint, ${args.stepIndex}::int, ${args.result ?? null}::jsonb)
      on conflict do nothing
    ), enqueued as (
      insert into treadle.jobs
        (queue, name, args, priority, max_attempts, workflow_run_id, step_index, idempotency_key)
      select j.queue, j.name, '{}'::jsonb, j.priority, j.max_attempts, j.workflow_run_id,
             ${next}::int, ${stepKey(args.runId, next)}
      from treadle.jobs j
      where j.id = ${args.jobId}::bigint and ${args.isLast}::boolean = false
      on conflict (idempotency_key) where idempotency_key is not null do nothing
    )
    update treadle.workflow_runs
    set current_step = case when ${args.isLast}::boolean then current_step else ${next}::int end,
        state = case when ${args.isLast}::boolean and state = 'running' then 'completed' else state end,
        finished_at = case when ${args.isLast}::boolean and state = 'running' then now() else finished_at end
    where id = ${args.runId}::bigint`;
}

export async function cancelWorkflowRun(sql: Sql, runId: string): Promise<boolean> {
  const rows = await sql`
    with j as (
      update treadle.jobs
      set state = case when state = 'running' then state else 'cancelled' end,
          cancel_requested = case when state = 'running' then true else cancel_requested end,
          finished_at = case when state = 'running' then finished_at else now() end
      where workflow_run_id = ${runId}::bigint and state in ('available', 'retryable', 'running')
      returning state
    )
    update treadle.workflow_runs w
    set state = case when exists (select 1 from j where j.state = 'running') then w.state else 'cancelled' end,
        finished_at = case when exists (select 1 from j where j.state = 'running') then w.finished_at else now() end
    where w.id = ${runId}::bigint and w.state = 'running'
    returning id`;
  return rows.length === 1;
}
