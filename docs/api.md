# API reference

All names are exported from `treadle`. Ids are strings.

## migrate(sql)

Creates or updates the `treadle` schema. Call it at startup in every process. Concurrent calls are serialised with an advisory lock; calls after the first apply nothing.

## new Treadle(sql)

The client. Holds the connection for `cancel`, `retry`, and `cancelWorkflow`. `enqueue` and `startWorkflow` write only through the transaction you pass.

### treadle.enqueue(tx, name, args?, options?) → Promise<string>

Inserts a job through `tx`. Returns the job id.

| Option | Default | Meaning |
|---|---|---|
| `queue` | `"default"` | Which workers pick it up |
| `priority` | `0` | Lower runs first within a queue |
| `runAt` | now | Earliest time to run |
| `maxAttempts` | `25` | Failures before the job is discarded |
| `idempotencyKey` | none | Same key, same job, ever |
| `every` | none | Milliseconds between occurrences; makes the job periodic |

`args` must be a JSON object, array, or null. `name` must be non-empty. `maxAttempts` and `every` must be positive integers.

### treadle.startWorkflow(tx, name, input?, options?) → Promise<string>

Inserts a workflow run and its first step job. Returns the run id. Options are `queue`, `priority`, `maxAttempts`, and `idempotencyKey`, applied to every step job. With an `idempotencyKey` that already exists, returns the existing run id.

### treadle.cancel(jobId) → Promise<boolean>

Cancels an `available` or `retryable` job at once. Flags a `running` job so its worker's next heartbeat aborts `ctx.signal`; the job ends as `cancelled` when the handler returns or the lease expires. Returns false if the job was already final or does not exist.

### treadle.retry(jobId) → Promise<boolean>

Moves a `discarded`, `cancelled`, or `retryable` job to `available` now, with `attempt` reset to 0 and any cancel flag cleared. If the job is a workflow step, reopens the run. Returns false otherwise.

### treadle.cancelWorkflow(runId) → Promise<boolean>

Cancels the run's current step job as `cancel` would, and marks the run `cancelled` once no step is running. Returns false if the run is not `running`.

## new Worker(sql, options?)

| Option | Default | Meaning |
|---|---|---|
| `queues` | `["default"]` | Queues to claim from, drained in this order |
| `concurrency` | `10` | Jobs in flight at once in this worker |
| `pollIntervalMs` | `1000` | Sleep when no job was claimed |
| `leaseMs` | `30000` | How long a claimed job is presumed alive without a heartbeat |
| `heartbeatMs` | `10000` | How often the lease is extended while a job runs |
| `rescueIntervalMs` | `15000` | How often expired leases are returned to the queue |
| `stopTimeoutMs` | `30000` | How long `stop()` waits for in-flight jobs |
| `backoff` | see below | `(attempt) => ms` delay before a retry |
| `workerId` | hostname, pid, random | Written on claimed rows |
| `onError` | logs to console | `(error, job?)` for handler errors and internal failures |
| `onEvent` | none | `(event, job)` for logging and metrics |

Default backoff: `min(2^attempt * 1000 + random() * 1000, 3600000)`.

Events: `claimed`, `finishing` (handler returned, completion not yet written), `completed`, `failed`, `stepFinished` (step result and next step committed), `leaseLost`. An exception inside `onEvent` is passed to `onError` and does not affect the job.

### worker.register(name, handler) → this

`handler(args, ctx)` returning a promise or a value. Throwing fails the job. Must be called before `start`.

### worker.registerWorkflow(name, steps) → this

`steps` is an array of `{ name, run }` where `run(input, results, ctx)` returns the step's result, which must be JSON serialisable. `results` is an object of earlier steps' results keyed by step name. Step names must be unique. Must be called before `start`.

### worker.start() → Promise<void>

Begins polling. Resolves at once.

### worker.stop() → Promise<void>

Stops claiming, waits up to `stopTimeoutMs` for in-flight jobs, then resolves. Jobs still running keep their lease and are rescued later.

### ctx

| Field | Meaning |
|---|---|
| `jobId` | Stable across retries and re-runs |
| `name`, `queue` | As enqueued |
| `attempt` | Starts at 1; increments on every claim, including a re-run after a crash |
| `signal` | An `AbortSignal` aborted with reason `"cancelled"` or `"lease lost"` |
| `heartbeat()` | Extends the lease now; use inside long synchronous work |

## dashboard(sql, options?) → (req: Request) => Promise<Response>

Returns a fetch handler. `options.basePath` is the prefix it is mounted under, `""` by default. Routes under the base path:

| Route | Meaning |
|---|---|
| `GET /` | The page |
| `GET /api/overview` | Counts, per-minute series, recent failures, runs |
| `GET /api/workflows/:id` | One run with its steps |
| `POST /api/jobs/:id/retry` | `Treadle.retry` |
| `POST /api/jobs/:id/cancel` | `Treadle.cancel` |
| `POST /api/workflows/:id/cancel` | `Treadle.cancelWorkflow` |

No authentication. Mount it behind your own.

## defaultBackoff(attempt) → number

The default backoff function, exported so you can wrap it.

## Types

`Job`, `JobState`, `JobContext`, `Handler`, `Step`, `EnqueueOptions`, `StartWorkflowOptions`, `WorkerOptions`, `WorkerEvent`, `DashboardOptions`, `Sql`.

## Tables

All in the `treadle` schema. Read them freely; write to them through the API.

- `jobs`: one row per job or workflow step. `state`, `attempt`, `lease_until`, `worker_id`, `last_error`, `workflow_run_id`, `step_index`.
- `workflow_runs`: `name`, `input`, `state` (`running`, `completed`, `failed`, `cancelled`), `current_step`.
- `step_results`: `workflow_run_id`, `step_index`, `result`.
- `migrations`: applied schema versions.
