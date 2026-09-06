# Operations

Running treadle workers in production.

## Processes

Run workers as their own processes, one per CPU core you want to give to jobs, and not inside your web server. A worker in a request process competes with requests for the event loop, and a deploy that restarts the web tier restarts your jobs. Each worker process calls `migrate`, builds a `Worker`, registers handlers, and starts. Several processes on one machine or across machines all pull from the same table.

Give each worker only the queues and handlers it should run. A worker claims only jobs whose names it has registered, so a process with one handler in a busy shared queue is not slowed by the others' jobs, unless the backlog of other jobs is very large; see the note on queues below.

## Shutdown

Handle `SIGTERM`: call `worker.stop()`, then close the pool, then exit. `stop` refuses new claims, waits for in-flight jobs up to `stopTimeoutMs`, and resolves. Set `stopTimeoutMs` below your orchestrator's kill timeout so a slow job does not turn a graceful stop into a SIGKILL. A job cut off by SIGKILL is not lost; it keeps its lease and another worker picks it up when the lease expires.

## Pool size

Bun's SQL client pools 10 connections by default. A worker at concurrency 10 with handlers that each run a few queries is comfortable on that. Pass `max` to `new SQL(url, { max })` if handlers hold connections for long or run many queries in parallel. Keep the total across processes below your Postgres `max_connections` with headroom for the application.

Handlers that use transactions of their own should use a pool separate from the worker's, or a larger pool. Under heavy load, pooled queries queuing behind transactions on the same pool have been seen to return another query's rows on Bun 1.3; the library avoids this internally by keeping every write a single statement, but your handler code is yours.

## Lease and heartbeat

The lease is how fast a dead worker's jobs come back. The default 30 seconds suits most work. For jobs that must recover quickly, lower `leaseMs` and `heartbeatMs` together; a heartbeat every third of the lease is a good ratio. For jobs that do long synchronous work that blocks the event loop, call `ctx.heartbeat()` at safe points, because the background heartbeat cannot run while the loop is blocked.

The rescuer runs in every worker every `rescueIntervalMs`. Recovery time is the lease plus up to one rescue interval; measured on one machine, a 5 second lease with a 1 second rescue interval recovered in 5.06 seconds.

## Queues

Use one queue per kind of worker, not one queue per job type. Claiming is fast regardless of how many finished rows the table holds, because the claim index covers only claimable rows. It is also fast with a large backlog of jobs the worker can run. The one slow case is a large backlog of jobs a worker has no handler for, in a queue it claims from: each claim walks past them. Give those jobs their own queue.

Queue order on a worker is drain order. `["interactive", "batch"]` runs batch jobs only when no interactive job is waiting.

## Migrations on deploy

`migrate` is safe to run from every process at startup, concurrently. It takes an advisory lock, applies any versions the database lacks, and returns. A treadle upgrade that adds a migration applies it the first time any process with the new version starts. Older processes keep working during a rolling deploy; treadle does not remove or rename columns in a minor version.

## Monitoring

`onEvent` fires per job for `claimed`, `finishing`, `completed`, `failed`, `stepFinished`, and `leaseLost`. Count them by job name for throughput and failure rate; time `claimed` to `completed` for duration. `onError` receives handler errors and internal failures such as a lost database connection; send it to your logger.

From SQL, the counts the dashboard shows come from `select queue, state, count(*) from treadle.jobs group by 1, 2`. Two numbers worth alerting on: rows in `available` or `retryable` with `run_at` older than a few minutes, which means workers are behind or down, and rows in `discarded` created recently, which means something is failing for good.

## Dashboard

`dashboard(sql, { basePath })` has no authentication. Mount it behind whatever protects the rest of your admin surface. It exposes retry and cancel, so treat it as an admin tool. Its read queries group over the whole jobs table, which is fine for a page a person refreshes and not fine to poll from a monitoring system; use the SQL above for that.

## Housekeeping

Completed and cancelled rows stay until you delete them. They do not slow claims, but they take space and make the dashboard's counts grow. A periodic job that deletes rows older than a retention window is the usual answer; [the periodic use case](use-cases/periodic-jobs.md) has one. Keep discarded rows longer, since they are the record of what failed.

## Version pinning

Treadle ships TypeScript source and runs only on Bun. Pin the version in `package.json` and read the changelog before upgrading; schema migrations are listed there.
