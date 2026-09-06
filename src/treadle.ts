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
      returning id::text as id`;

    return rows[0]!.id as string;
  }
}
