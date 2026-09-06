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

export async function completeJob(sql: Sql, jobId: string, workerId: string): Promise<boolean> {
  const rows = await sql`
    update treadle.jobs
    set state = 'completed', finished_at = now(), lease_until = null, worker_id = null
    where id = ${jobId} and state = 'running' and worker_id = ${workerId}
    returning id`;
  return rows.length === 1;
}

export async function failJob(
  sql: Sql,
  jobId: string,
  workerId: string,
  error: string,
  runAt: Date,
): Promise<boolean> {
  const rows = await sql`
    update treadle.jobs
    set state = 'retryable', last_error = ${error}, run_at = ${runAt},
        lease_until = null, worker_id = null
    where id = ${jobId} and state = 'running' and worker_id = ${workerId}
    returning id`;
  return rows.length === 1;
}

export async function extendLease(
  sql: Sql,
  jobId: string,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const rows = await sql`
    update treadle.jobs
    set lease_until = now() + (${leaseMs} * interval '1 millisecond')
    where id = ${jobId} and state = 'running' and worker_id = ${workerId}
    returning id`;
  return rows.length === 1;
}

export async function rescueExpired(sql: Sql): Promise<number> {
  const rows = await sql`
    update treadle.jobs
    set state = 'retryable', lease_until = null, worker_id = null, last_error = 'lease expired'
    where state = 'running' and lease_until < now()
    returning id`;
  return rows.length;
}
