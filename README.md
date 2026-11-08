# Treadle

Background jobs and step workflows for Bun, stored in Postgres.

If your application already runs on Postgres, Treadle gives you a job queue without adding Redis or a message broker. You enqueue jobs in the same transaction as your data, so if the transaction rolls back, the job goes with it.

## Install

    bun add treadle

Treadle requires Bun 1.3 or later and Postgres 12 or later. It uses Bun's built-in SQL client and has no runtime dependencies.

## Usage

```ts
import { SQL } from "bun";
import { dashboard, migrate, Treadle, Worker } from "treadle";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

// The job and the workflow exist only if this transaction commits.
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
- [Concepts](docs/concepts.md) explains the guarantees and what they require of your handlers.
- [Use cases](docs/use-cases/README.md) has runnable examples for signup emails, webhooks, withdrawals, order fulfilment, periodic jobs, media processing, bulk imports, rate-limited APIs, and multi-tenant work.
- [Operations](docs/operations.md) covers running workers in production.
- [API reference](docs/api.md)
- [Comparison](docs/comparison.md) helps you decide whether Treadle fits your project.
- [Changelog](CHANGELOG.md)

## Guarantees

- A job enqueued inside a transaction runs at least once if the transaction commits. It never runs if the transaction rolls back.
- A workflow that crashes resumes at the first step without a saved result. Steps that already finished do not run again.
- Enqueuing twice with the same idempotency key creates one job, however many enqueues run concurrently.
- If a worker dies during a job, another worker can pick the job up once its lease expires.

Execution is at-least-once, so a handler can run twice if the process dies after the handler finishes but before Treadle records completion. Make side effects idempotent, or key them on `ctx.jobId` and `ctx.attempt`.

## How it works

Workers claim jobs with `select ... for update skip locked`. The same statement sets a lease and a worker ID, which lets any number of workers share one table without blocking each other or claiming the same job.

While a handler runs, a heartbeat extends its lease. A rescuer returns expired leases to the queue. Every write after the claim checks the worker ID, so a worker that has lost its lease cannot overwrite newer state.

Failed jobs retry with exponential backoff and jitter, and are discarded after `maxAttempts`. Completing a job is a single statement, including re-enqueuing a periodic job or starting the next workflow step, so it commits atomically without an extra transaction round trip.

The claim index only covers claimable states, which keeps completed rows from slowing down claims.

## Performance

These results come from a laptop with Postgres on the same machine, one process per worker, and empty handlers. Expect different absolute numbers on your hardware.

| Measurement | Result |
|---|---|
| 1 worker, concurrency 10 | 863 jobs/s |
| 8 workers, concurrency 10 | 4,750 jobs/s |
| Claim latency, 10k rows | p50 2.6 ms, p99 6.4 ms |
| Claim latency, 1M rows, 999k completed | p50 2.1 ms, p99 8.2 ms |
| Claim latency, 1M rows, all waiting | p50 2.4 ms, p99 7.3 ms |
| Recovery after killing a worker, 5 s lease | 5.1 s |
| 1,000 concurrent enqueues of one idempotency key | 1 row, 167 ms |

Claims slow down when a queue holds a large backlog of jobs the worker has no handler for, because each claim has to walk past them. Use a separate queue for each worker type to avoid this.

## API

- `migrate(sql)` creates or updates the `treadle` schema. It is safe to call from every process at startup.
- `new Treadle(sql)` provides `enqueue(tx, name, args, options)`, `startWorkflow(tx, name, input, options)`, `cancel(jobId)`, `retry(jobId)`, and `cancelWorkflow(runId)`.
- Enqueue options are `queue`, `priority`, `runAt`, `maxAttempts`, `idempotencyKey`, and `every` (in milliseconds, for periodic jobs).
- `new Worker(sql, options)` provides `register(name, handler)`, `registerWorkflow(name, steps)`, `start()`, and `stop()`. Its options are `queues`, `concurrency`, `pollIntervalMs`, `leaseMs`, `heartbeatMs`, `rescueIntervalMs`, `stopTimeoutMs`, `backoff`, `onError`, and `onEvent`.
- Handlers receive `(args, ctx)`, where `ctx` has `jobId`, `attempt`, `signal` (aborted on cancel or a lost lease), and `heartbeat()`.
- Workflow steps receive `(input, results, ctx)`, where `results` holds the return values of earlier steps by step name.
- `dashboard(sql, { basePath })` returns a fetch handler. Mount it behind your own authentication. Adding `#run=<id>` to the URL opens that run.

Job and run IDs are strings because a Postgres `bigint` does not fit in a JavaScript number.

## Benchmarks

    WORKERS=4 JOBS=10000 bun run load
    ROWS=1000000 SAMPLES=1000 bun run claim-latency
    LEASE_MS=5000 bun run recovery
    N=1000 bun run storm

Each benchmark uses the `treadle_load` database on your Postgres server and drops its `treadle` schema first.

## Development

Tests need a Postgres server at `DATABASE_URL`, which defaults to `postgres://postgres:postgres@127.0.0.1:5432/treadle_test`. Run `docker compose up -d` to start one.

    bun install
    bun test

The tests run against a real database. Five of them kill a child worker with SIGKILL at chosen points and check how Treadle recovers.

## License

MIT
