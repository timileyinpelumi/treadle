# Getting started

Treadle runs background jobs and step workflows using the Postgres database your application already has. This page takes you from install to a running worker and a dashboard.

## Requirements

- Bun 1.3 or later. Treadle uses Bun's built in SQL client and does not run on Node.
- Postgres 12 or later. Any hosted or local instance works.

## Install

    bun add treadle

## Create the schema

Call `migrate` once at startup in every process that uses treadle. It creates a `treadle` schema with three tables and is safe to call from many processes at once; the second and later calls do nothing.

```ts
import { SQL } from "bun";
import { migrate } from "treadle";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
```

## Enqueue a job

Enqueue inside your own transaction. The job row commits with your data, or rolls back with it.

```ts
import { Treadle } from "treadle";

const treadle = new Treadle(sql);

await sql.begin(async (tx) => {
  await tx`insert into users (email) values (${"a@example.com"})`;
  await treadle.enqueue(tx, "welcome-email", { email: "a@example.com" });
});
```

The first argument is the transaction, the second is the job name, the third is the arguments as a JSON object. `enqueue` returns the job id as a string.

## Run a worker

A worker claims jobs it has handlers for and runs them concurrently.

```ts
import { Worker } from "treadle";

const worker = new Worker(sql, { queues: ["default"], concurrency: 10 });

worker.register("welcome-email", async (args: { email: string }, ctx) => {
  console.log(`sending to ${args.email}, attempt ${ctx.attempt}`);
});

await worker.start();
```

A handler that returns marks the job completed. A handler that throws marks it for retry with exponential backoff; after `maxAttempts` failures, 25 by default, the job is discarded with its last error kept.

Handlers can run more than once. If the process dies after your handler finishes and before treadle records completion, the job runs again. See [Concepts](concepts.md) for how to write handlers that are safe under that rule.

## Stop cleanly

On shutdown, stop the worker so in-flight jobs finish before the process exits.

```ts
process.on("SIGTERM", async () => {
  await worker.stop();
  await sql.end();
  process.exit(0);
});
```

`stop` waits up to `stopTimeoutMs`, 30 seconds by default. A job still running after that keeps its lease and is picked up by another worker once the lease expires.

## Serve the dashboard

`dashboard` returns a fetch handler. Mount it anywhere, behind your own authentication.

```ts
import { dashboard } from "treadle";

Bun.serve({ port: 3000, fetch: dashboard(sql, { basePath: "/admin/jobs" }) });
```

Open `/admin/jobs/` to see counts by state, finished jobs per minute, recent failures with retry and cancel, and workflow runs with their steps.

## Run a workflow

A workflow is an ordered list of steps. Each step's result is saved before the next step starts, so a crash resumes at the first unfinished step.

```ts
await sql.begin(async (tx) => {
  await treadle.startWorkflow(tx, "withdraw", { accountId, amount });
});

worker.registerWorkflow("withdraw", [
  { name: "reserve", run: async (input) => ({ holdId: await reserve(input) }) },
  { name: "send",    run: async (input, results) => ({ ref: await send(input, results.reserve.holdId) }) },
  { name: "settle",  run: async (input, results) => { await settle(results.send.ref); } },
]);
```

Each step receives the workflow input and an object of earlier results keyed by step name.

## The whole thing

[examples/getting-started.ts](../examples/getting-started.ts) is the complete file. Run it with a `DATABASE_URL` set:

    DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/myapp bun examples/getting-started.ts

## Next

- [Concepts](concepts.md): what treadle guarantees and what it asks of your handlers.
- [Use cases](use-cases/): worked examples for common jobs.
- [Operations](operations.md): running workers in production.
- [API reference](api.md).
