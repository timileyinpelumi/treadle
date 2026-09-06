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

export interface JobContext {
  jobId: string;
  name: string;
  queue: string;
  attempt: number;
  signal: AbortSignal;
  heartbeat(): Promise<void>;
}

export type Handler<A = any> = (args: A, ctx: JobContext) => Promise<unknown> | unknown;

export interface WorkerOptions {
  queues?: string[];
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  rescueIntervalMs?: number;
  stopTimeoutMs?: number;
  workerId?: string;
  onError?: (error: unknown, job?: Job) => void;
}
