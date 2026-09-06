export type JobState =
  | "available"
  | "running"
  | "completed"
  | "retryable"
  | "discarded"
  | "cancelled";

export interface EnqueueOptions {
  queue?: string;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
  every?: number;
}

export interface Job {
  id: string;
  queue: string;
  name: string;
  args: unknown;
  state: JobState;
  priority: number;
  run_at: Date;
  attempt: number;
  max_attempts: number;
  lease_until: Date | null;
  worker_id: string | null;
  idempotency_key: string | null;
  every_ms: number | null;
  workflow_run_id: string | null;
  step_index: number | null;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}
