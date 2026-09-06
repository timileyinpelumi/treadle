import { hostname } from "node:os";
import { claimJobs, completeJob, extendLease, failJob, rescueExpired } from "./queries";
import type { Sql } from "./sql";
import type { Handler, Job, JobContext, WorkerOptions } from "./types";

const RETRY_DELAY_MS = 1000;

export class Worker {
  readonly id: string;
  readonly options: Required<Omit<WorkerOptions, "workerId" | "onError">> & {
    onError: (error: unknown, job?: Job) => void;
  };

  private handlers = new Map<string, Handler>();
  private inflight = new Map<string, Promise<void>>();
  private running = false;
  private loop: Promise<void> | null = null;
  private rescueTimer: Timer | null = null;
  private wake: (() => void) | null = null;

  constructor(readonly sql: Sql, options: WorkerOptions = {}) {
    this.id = options.workerId ?? `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
    this.options = {
      queues: options.queues ?? ["default"],
      concurrency: options.concurrency ?? 10,
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      leaseMs: options.leaseMs ?? 30_000,
      heartbeatMs: options.heartbeatMs ?? 10_000,
      rescueIntervalMs: options.rescueIntervalMs ?? 15_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 30_000,
      onError: options.onError ?? ((error, job) => console.error("treadle worker error", { jobId: job?.id, error })),
    };
  }

  register(name: string, handler: Handler): this {
    if (this.running) throw new Error("register: cannot register handlers after start");
    this.handlers.set(name, handler);
    return this;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.rescueTimer = setInterval(() => {
      rescueExpired(this.sql).catch((e) => this.options.onError(e));
    }, this.options.rescueIntervalMs);
    this.rescueTimer.unref();
    this.loop = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.rescueTimer) clearInterval(this.rescueTimer);
    this.wakeUp();
    await this.loop;
    const drained = Promise.allSettled([...this.inflight.values()]);
    await Promise.race([drained, Bun.sleep(this.options.stopTimeoutMs)]);
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const free = this.options.concurrency - this.inflight.size;
      let claimed = 0;
      if (free > 0) {
        try {
          const jobs = await claimJobs(this.sql, {
            queues: this.options.queues,
            names: [...this.handlers.keys()],
            limit: free,
            leaseMs: this.options.leaseMs,
            workerId: this.id,
          });
          claimed = jobs.length;
          for (const job of jobs) this.track(job);
        } catch (e) {
          this.options.onError(e);
        }
      }
      // A full batch means more may be waiting; poll again at once. Otherwise
      // sleep until the interval passes, a slot frees up, or stop() is called.
      if (claimed < free || free === 0) await this.sleep(this.options.pollIntervalMs);
    }
  }

  private track(job: Job): void {
    const p = this.run(job).finally(() => {
      this.inflight.delete(job.id);
      this.wakeUp();
    });
    this.inflight.set(job.id, p);
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.name)!;
    const abort = new AbortController();
    const ctx: JobContext = {
      jobId: job.id,
      name: job.name,
      queue: job.queue,
      attempt: job.attempt,
      signal: abort.signal,
      heartbeat: () => this.heartbeat(job, abort),
    };
    const beat = setInterval(() => {
      ctx.heartbeat().catch((e) => this.options.onError(e, job));
    }, this.options.heartbeatMs);
    try {
      await handler(job.args, ctx);
      const state = await completeJob(this.sql, job.id, this.id);
      if (state === null) this.options.onError(new Error("lease lost before completion"), job);
    } catch (error) {
      this.options.onError(error, job);
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      await failJob(this.sql, job.id, this.id, message, RETRY_DELAY_MS)
        .catch((e) => this.options.onError(e, job));
    } finally {
      clearInterval(beat);
    }
  }

  private async heartbeat(job: Job, abort: AbortController): Promise<void> {
    const { held, cancelRequested } = await extendLease(this.sql, job.id, this.id, this.options.leaseMs);
    if (abort.signal.aborted) return;
    if (!held) abort.abort(new Error("lease lost"));
    else if (cancelRequested) abort.abort(new Error("cancelled"));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  private wakeUp(): void {
    this.wake?.();
  }
}
