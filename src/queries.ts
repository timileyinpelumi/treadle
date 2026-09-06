import type { Sql } from "./sql";
import type { Job } from "./types";

const columns = `
  j.id::text as id, j.queue, j.name, j.args, j.state, j.priority, j.run_at,
  j.attempt, j.max_attempts, j.lease_until, j.worker_id, j.idempotency_key,
  j.every_ms, j.workflow_run_id::text as workflow_run_id, j.step_index,
  j.last_error, j.created_at, j.started_at, j.finished_at`;

export async function claimJobs(
  sql: Sql,
  args: { queues: string[]; names: string[]; limit: number; leaseMs: number; workerId: string },
): Promise<Job[]> {
  if (args.limit < 1 || args.queues.length === 0 || args.names.length === 0) return [];
  return sql.unsafe(
    `with next as (
       select id from treadle.jobs
       where state in ('available', 'retryable')
         and queue = any($1::text[])
         and name = any($2::text[])
         and run_at <= now()
       order by priority, run_at
       limit $3
       for update skip locked
     )
     update treadle.jobs j
     set state = 'running',
         attempt = j.attempt + 1,
         lease_until = now() + ($4 * interval '1 millisecond'),
         worker_id = $5,
         started_at = coalesce(j.started_at, now())
     from next
     where j.id = next.id
     returning ${columns}`,
    [toPgArray(args.queues), toPgArray(args.names), args.limit, args.leaseMs, args.workerId],
  );
}

// Bun sends JS arrays as a bare "a,b" literal, which Postgres rejects. Build the {} form ourselves.
function toPgArray(items: string[]): string {
  return "{" + items.map((s) => '"' + s.replace(/(["\\])/g, "\\$1") + '"').join(",") + "}";
}

export type FinalState = "completed" | "retryable" | "discarded" | "cancelled";

// Finishing is one statement: the update and, for periodic jobs, the insert of the
// next occurrence run as data-modifying CTEs and commit together. Wrapping these in
// sql.begin instead made Bun's pool hand one caller another caller's rows under load.
export async function completeJob(sql: Sql, jobId: string, workerId: string): Promise<FinalState | null> {
  const rows = await sql`
    with done as (
      update treadle.jobs
      set state = case when cancel_requested then 'cancelled' else 'completed' end,
          finished_at = now(), lease_until = null, worker_id = null
      where id = ${jobId} and state = 'running' and worker_id = ${workerId}
      returning state, every_ms, queue, name, args, priority, max_attempts
    ), next as (
      insert into treadle.jobs (queue, name, args, priority, max_attempts, every_ms, run_at)
      select queue, name, args, priority, max_attempts, every_ms,
             now() + (every_ms * interval '1 millisecond')
      from done where every_ms is not null and state = 'completed'
    )
    select state from done`;
  return (rows[0]?.state as FinalState | undefined) ?? null;
}

export async function failJob(
  sql: Sql,
  jobId: string,
  workerId: string,
  error: string,
  backoffMs: number,
): Promise<FinalState | null> {
  const rows = await sql`
    with done as (
      update treadle.jobs
      set state = case
            when cancel_requested then 'cancelled'
            when attempt >= max_attempts then 'discarded'
            else 'retryable' end,
          last_error = ${error},
          run_at = case
            when cancel_requested or attempt >= max_attempts then run_at
            else now() + (${backoffMs} * interval '1 millisecond') end,
          finished_at = case
            when cancel_requested or attempt >= max_attempts then now()
            else null end,
          lease_until = null, worker_id = null
      where id = ${jobId} and state = 'running' and worker_id = ${workerId}
      returning state, every_ms, queue, name, args, priority, max_attempts
    ), next as (
      insert into treadle.jobs (queue, name, args, priority, max_attempts, every_ms, run_at)
      select queue, name, args, priority, max_attempts, every_ms,
             now() + (every_ms * interval '1 millisecond')
      from done where every_ms is not null and state = 'discarded'
    )
    select state from done`;
  return (rows[0]?.state as FinalState | undefined) ?? null;
}

export async function extendLease(
  sql: Sql,
  jobId: string,
  workerId: string,
  leaseMs: number,
): Promise<{ held: boolean; cancelRequested: boolean }> {
  const rows = await sql`
    update treadle.jobs
    set lease_until = now() + (${leaseMs} * interval '1 millisecond')
    where id = ${jobId} and state = 'running' and worker_id = ${workerId}
    returning cancel_requested`;
  const row = rows[0] as { cancel_requested: boolean } | undefined;
  return { held: row !== undefined, cancelRequested: row?.cancel_requested ?? false };
}

export async function rescueExpired(sql: Sql): Promise<number> {
  const rows = await sql`
    with done as (
      update treadle.jobs
      set state = case
            when cancel_requested then 'cancelled'
            when attempt >= max_attempts then 'discarded'
            else 'retryable' end,
          finished_at = case
            when cancel_requested or attempt >= max_attempts then now()
            else finished_at end,
          -- the worker died, the job did not fail, so no backoff
          run_at = now(),
          lease_until = null, worker_id = null, last_error = 'lease expired'
      where state = 'running' and lease_until < now()
      returning state, every_ms, queue, name, args, priority, max_attempts
    ), next as (
      insert into treadle.jobs (queue, name, args, priority, max_attempts, every_ms, run_at)
      select queue, name, args, priority, max_attempts, every_ms,
             now() + (every_ms * interval '1 millisecond')
      from done where every_ms is not null and state = 'discarded'
    )
    select count(*)::int as n from done`;
  return (rows[0]?.n as number) ?? 0;
}
