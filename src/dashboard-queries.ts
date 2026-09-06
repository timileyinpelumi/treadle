import type { Sql } from "./sql";

export interface CountRow { queue: string; state: string; n: number }
export interface MinuteRow { minute: string; state: string; n: number }
export interface FailureRow {
  id: string; queue: string; name: string; state: string; attempt: number;
  max_attempts: number; last_error: string; at: string;
}
export interface RunRow {
  id: string; name: string; state: string; current_step: number; created_at: string; finished_at: string | null;
}
export interface StepRow {
  step_index: number; job_id: string; state: string; attempt: number; last_error: string | null;
  result: unknown; has_result: boolean;
}

export async function overview(sql: Sql): Promise<{ counts: CountRow[]; perMinute: MinuteRow[] }> {
  const counts = await sql`
    select queue, state, count(*)::int as n from treadle.jobs
    group by queue, state order by queue, state`;
  const perMinute = await sql`
    select to_char(date_trunc('minute', finished_at at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:00"Z"') as minute, state, count(*)::int as n
    from treadle.jobs
    where finished_at > now() - interval '1 hour' and state in ('completed', 'discarded')
    group by 1, 2 order by 1, 2`;
  return { counts: counts as CountRow[], perMinute: perMinute as MinuteRow[] };
}

export async function recentFailures(sql: Sql, limit = 50): Promise<FailureRow[]> {
  return (await sql`
    select id::text as id, queue, name, state, attempt, max_attempts, last_error,
           coalesce(finished_at, run_at)::text as at
    from treadle.jobs
    where last_error is not null and state in ('retryable', 'discarded')
    order by coalesce(finished_at, run_at) desc, id desc
    limit ${limit}`) as FailureRow[];
}

export async function workflowRuns(sql: Sql, limit = 50): Promise<RunRow[]> {
  return (await sql`
    select id::text as id, name, state, current_step, created_at::text as created_at, finished_at::text as finished_at
    from treadle.workflow_runs order by id desc limit ${limit}`) as RunRow[];
}

export async function workflowRun(
  sql: Sql,
  id: string,
): Promise<{ run: RunRow & { input: unknown }; steps: StepRow[] } | null> {
  if (!/^\d+$/.test(id)) return null;
  const [run] = await sql`
    select id::text as id, name, state, current_step, input, created_at::text as created_at, finished_at::text as finished_at
    from treadle.workflow_runs where id = ${id}::bigint`;
  if (!run) return null;
  const steps = await sql`
    select j.step_index, j.id::text as job_id, j.state, j.attempt, j.last_error,
           r.result, (r.workflow_run_id is not null) as has_result
    from treadle.jobs j
    left join treadle.step_results r on r.workflow_run_id = j.workflow_run_id and r.step_index = j.step_index
    where j.workflow_run_id = ${id}::bigint
    order by j.step_index`;
  return { run: run as RunRow & { input: unknown }, steps: steps as StepRow[] };
}
