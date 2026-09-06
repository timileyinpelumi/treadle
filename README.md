# Treadle

Background jobs and step workflows for Bun and Postgres. One table, no broker, no build step.

    bun add treadle

Needs Bun 1.3 or later and Postgres 12 or later. Uses Bun's built in SQL client; there are no runtime dependencies.

## Example

```ts
import { SQL } from "bun";
import { dashboard, migrate, Treadle, Worker } from "treadle";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

// Enqueue inside your own transaction. The job commits with your data or not at all.
await sql.begin(async (tx) => {
  await tx`insert into withdrawals (id, amount) values (${id}, ${amount})`;
  await treadle.enqueue(tx, "notify", { id }, { idempotencyKey: `notify:${id}` });
  await treadle.startWorkflow(tx, "withdraw", { id });
});

const worker = new Worker(sql, { queues: ["default"], concurrency: 10 });
worker.register("notify", async ({ id }) => { /* send the email */ });
worker.registerWorkflow("withdraw", [
  { name: "reserve", run: async ({ id }) => ({ holdId: await reserve(id) }) },
  { name: "send",    run: async ({ id }, results) => ({ ref: await send(id, results.reserve.holdId) }) },
  { name: "settle",  run: async ({ id }, results) => { await settle(id, results.send.ref); } },
]);
await worker.start();

Bun.serve({ port: 3000, fetch: dashboard(sql, { basePath: "/admin/jobs" }) });
```

## Documentation

- [Getting started](docs/getting-started.md)
- [Concepts](docs/concepts.md): the guarantees and what they ask of your handlers
- [Use cases](docs/use-cases/README.md): signup emails, webhooks, withdrawals, order fulfilment, periodic jobs, media, bulk import, rate-limited APIs, multi-tenant work, each with a runnable example
- [Operations](docs/operations.md): running workers in production
- [API reference](docs/api.md)
- [When to use it, and when not to](docs/comparison.md)
- [Changelog](CHANGELOG.md)

## What it guarantees

- A job enqueued inside a transaction runs at least once if that transaction commits, and never if it rolls back. The jobs table is the transactional outbox.
- A workflow that crashes resumes at the first step without a persisted result. Completed steps are not run again.
- Two enqueues with the same idempotency key produce one job, under any concurrency. A thousand simultaneous enqueues of one key yield one row.
- A worker that dies mid-job loses at most one lease duration before another worker picks the job up.

Execution is at least once. A handler can run twice if the process dies between the handler finishing and the completion write. Make side effects idempotent, or key them on `ctx.jobId` and `ctx.attempt`.

## How it works

Workers claim jobs with `select ... for update skip locked` in one statement that also sets a lease and a worker id, so any number of workers pull from one table without blocking or double-claiming. A heartbeat extends the lease while a handler runs; a rescuer returns expired leases to the queue. Every write after the claim is guarded by the worker id, so a worker that lost its lease cannot overwrite what a rescuer or another worker did. Failed jobs back off exponentially with jitter and are discarded after `maxAttempts`. Finishing a job, including re-enqueueing a periodic job or the next workflow step, is a single statement, so it commits atomically without a transaction round trip. The claim index is partial on claimable states, so completed rows do not slow claims down.

## Numbers

Measured on a laptop with Postgres on the same machine, one process per worker, empty handlers. Relative figures transfer; absolute ones depend on hardware.

| Measurement | Result |
|---|---|
| 1 worker, concurrency 10 | 863 jobs/s |
| 8 workers, concurrency 10 | 4750 jobs/s |
| Claim latency, 10k rows | p50 2.6 ms, p99 6.4 ms |
| Claim latency, 1M rows, 999k completed | p50 2.1 ms, p99 8.2 ms |
| Claim latency, 1M rows all waiting | p50 2.4 ms, p99 7.3 ms |
| Recovery after a worker is killed, 5 s lease | 5.1 s |
| 1000 concurrent enqueues of one idempotency key | 1 row, 167 ms |

One known slow case: a large backlog of jobs a worker has no handler for, in the same queue it claims from, makes each claim walk past them. Use a queue per worker type.

## API

- `migrate(sql)` creates or updates the `treadle` schema. Safe to call from every process at startup.
- `new Treadle(sql)` with `enqueue(tx, name, args, options)`, `startWorkflow(tx, name, input, options)`, `cancel(jobId)`, `retry(jobId)`, `cancelWorkflow(runId)`.
- Enqueue options: `queue`, `priority`, `runAt`, `maxAttempts`, `idempotencyKey`, `every` (milliseconds, for periodic jobs).
- `new Worker(sql, options)` with `register(name, handler)`, `registerWorkflow(name, steps)`, `start()`, `stop()`. Options: `queues`, `concurrency`, `pollIntervalMs`, `leaseMs`, `heartbeatMs`, `rescueIntervalMs`, `stopTimeoutMs`, `backoff`, `onError`, `onEvent`.
- Handlers receive `(args, ctx)` with `ctx.jobId`, `ctx.attempt`, `ctx.signal` (aborted on cancel or lost lease), and `ctx.heartbeat()`.
- Steps receive `(input, results, ctx)` where `results` holds earlier steps' return values keyed by step name.
- `dashboard(sql, { basePath })` returns a fetch handler. Mount it behind your own auth. `#run=<id>` in the URL opens that run.

Job ids and run ids are strings, because Postgres bigint does not fit in a JavaScript number.

## Benchmarks

    WORKERS=4 JOBS=10000 bun run load
    ROWS=1000000 SAMPLES=1000 bun run claim-latency
    LEASE_MS=5000 bun run recovery
    N=1000 bun run storm

All use the `treadle_load` database on the same Postgres and drop the treadle schema there first.

## Develop

Needs a Postgres reachable at `DATABASE_URL`, default `postgres://postgres:postgres@127.0.0.1:5432/treadle_test`. `docker compose up -d` provides one.

    bun install
    bun test

Tests run against the real database. Five of them kill a child worker process with SIGKILL at chosen points and check what recovery does.

## Licence

MIT
