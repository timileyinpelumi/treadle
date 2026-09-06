import type { Sql } from "./sql";
import type { EnqueueOptions } from "./types";

export class Treadle {
  constructor(readonly sql: Sql) {}

  async enqueue(
    tx: Sql,
    name: string,
    args: unknown = {},
    options: EnqueueOptions = {},
  ): Promise<string> {
    if (!name) throw new Error("enqueue: name is required");
    const maxAttempts = options.maxAttempts ?? 25;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("enqueue: maxAttempts must be a positive integer");
    }
    if (args !== null && typeof args !== "object") {
      throw new Error("enqueue: args must be an object, an array, or null");
    }
    if (options.every !== undefined && (!Number.isInteger(options.every) || options.every < 1)) {
      throw new Error("enqueue: every must be a positive integer of milliseconds");
    }

    const rows = await tx`
      insert into treadle.jobs
        (queue, name, args, priority, run_at, max_attempts, idempotency_key, every_ms)
      values (
        ${options.queue ?? "default"},
        ${name},
        ${args ?? {}}::jsonb,
        ${options.priority ?? 0},
        ${options.runAt ?? new Date()},
        ${maxAttempts},
        ${options.idempotencyKey ?? null},
        ${options.every ?? null}
      )
      on conflict (idempotency_key) where idempotency_key is not null do nothing
      returning id::text as id`;

    if (rows.length > 0) return rows[0]!.id as string;

    const existing = await tx`
      select id::text as id from treadle.jobs
      where idempotency_key = ${options.idempotencyKey!}`;
    return existing[0]!.id as string;
  }

  async cancel(jobId: string): Promise<boolean> {
    const rows = await this.sql`
      update treadle.jobs
      set state = case when state = 'running' then state else 'cancelled' end,
          cancel_requested = case when state = 'running' then true else cancel_requested end,
          finished_at = case when state = 'running' then finished_at else now() end
      where id = ${jobId} and state in ('available', 'retryable', 'running')
      returning id`;
    return rows.length === 1;
  }

  async retry(jobId: string): Promise<boolean> {
    const rows = await this.sql`
      update treadle.jobs
      set state = 'available', attempt = 0, run_at = now(), cancel_requested = false,
          finished_at = null, lease_until = null, worker_id = null
      where id = ${jobId} and state in ('discarded', 'cancelled', 'retryable')
      returning id`;
    return rows.length === 1;
  }
}
