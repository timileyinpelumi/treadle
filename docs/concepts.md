# Concepts

What treadle guarantees, how it keeps each guarantee, and what that means for the code you write.

## Two guarantees

1. A job enqueued inside a transaction runs at least once if that transaction commits, and never if it rolls back.
2. A workflow that crashes resumes at the first step whose result was not saved. Steps with saved results are not run again.

Everything else on this page follows from how those two are kept.

## The outbox

Most job systems keep jobs somewhere other than your data: Redis, a broker, a hosted API. Writing your data and then sending the job are two operations, and a process can die between them. The job is lost, or worse, the data rolls back and the job runs anyway.

Treadle's jobs table lives in your database, and `enqueue` takes your open transaction. The job row and your data commit together. There is no gap. This pattern is called the transactional outbox, and it is the reason the API asks for a transaction rather than opening its own connection.

## Job states

| State | Meaning |
|---|---|
| `available` | waiting to run; `run_at` may be in the future |
| `running` | claimed by a worker that holds a lease on it |
| `retryable` | failed; will be claimable again when its backoff passes |
| `completed` | finished without error |
| `discarded` | failed `max_attempts` times; the last error is kept |
| `cancelled` | cancelled through the client or the dashboard |

`completed`, `discarded`, and `cancelled` are final. The dashboard's retry and `Treadle.retry` move a discarded or cancelled job back to `available` with its attempt count reset.

## Claiming

Workers poll. Each poll is one statement that finds the next claimable rows in priority order, locks them with `for update skip locked`, and marks them running. `skip locked` means a row another worker is claiming at the same instant is skipped rather than waited for, so any number of workers pull from one table without coordination or double-claiming.

A worker only claims jobs whose names it has handlers for, and only from the queues it was given. Queues are drained in the order listed: a worker on `["urgent", "batch"]` takes batch jobs only when no urgent job is waiting. Within a queue, lower `priority` numbers run first, then earlier `run_at`.

## Lease, heartbeat, rescue

The claim is a short transaction, so Postgres does not know whether the worker is alive while the handler runs. The lease answers that. Claiming sets `lease_until`, 30 seconds ahead by default. While the handler runs, the worker extends the lease on a heartbeat, every 10 seconds by default. Every worker also runs a rescuer that returns jobs with expired leases to the queue.

If a worker dies, its jobs wait at most one lease plus one rescue interval before another worker picks them up. Shorter leases mean faster recovery and more heartbeat traffic. For jobs longer than the heartbeat interval, nothing changes; the heartbeat runs in the background. For jobs that block the event loop, call `ctx.heartbeat()` yourself at safe points.

Every write a worker makes after claiming carries `where state = 'running' and worker_id = <me>`. A worker whose lease was taken by the rescuer, or whose job was re-claimed by someone else, gets zero rows back and does nothing further. This is what stops a slow worker from overwriting a fast one.

## At least once

A worker can run your handler to completion and die before recording that the job is done. On recovery, the job looks unfinished and runs again. No job system can prevent this, because your side effect and the completion record are in different places and cannot commit together.

So the rule is: a handler must be safe to run twice. Ways to get there, in order of preference:

- **Make the effect idempotent at the destination.** Send an idempotency key to the payment provider. Use `insert ... on conflict do nothing`. Set a value rather than incrementing it.
- **Check before acting.** Read your own state first: if the email was already marked sent, return.
- **Key on the job.** `ctx.jobId` is stable across retries of the same job. Use it as the idempotency key for the outside call.

The attempt number is `ctx.attempt`, starting at 1. It goes up on every claim, including a re-run after a crash, so it counts runs rather than failures, and a crash counts toward `maxAttempts`. A job whose worker keeps dying is eventually discarded rather than retried forever.

## Idempotency keys on enqueue

Two enqueues with the same `idempotencyKey` produce one job. The second returns the first's id and inserts nothing. This holds under any concurrency, because it is a unique index in Postgres doing the work.

The key means "this logical job, ever". It still deduplicates after the job completed. A key that should recur needs something that changes in it, such as a date: `report:2026-09-06`.

## Retries

A handler that throws moves the job to `retryable` with `run_at` set to now plus a backoff. The default backoff is 2 to the attempt in seconds, plus up to a second of random jitter, capped at an hour. Attempts 1, 2, 3 wait about 2, 4, 8 seconds. Jitter stops jobs that failed together from retrying together. After `maxAttempts` failures the job is `discarded` with its error.

Pass `backoff` to the worker to change the schedule. Pass `maxAttempts` on enqueue to change the limit per job.

## Cancel

`Treadle.cancel(jobId)` on a waiting job cancels it at once. On a running job it sets a flag; the worker's next heartbeat sees the flag and aborts `ctx.signal` with the reason `"cancelled"`. Whatever the handler does after that, the job ends as `cancelled`. Cancel is cooperative: Postgres cannot interrupt JavaScript, so a handler that ignores the signal runs to the end, and its side effects still happen.

## Periodic jobs

`enqueue` with `every: ms` makes a periodic job. After each run completes or is discarded, the next occurrence is inserted with `run_at` advanced by the interval. Each occurrence is its own row with its own attempts. Cancelling an occurrence ends the chain. The idempotency key is not copied, so key the first enqueue and the chain is created once.

## Step workflows

A workflow is a name and an ordered list of steps. Starting one inserts a run and a job for step zero. Each step is an ordinary job, so claiming, leases, retries, and cancel all apply.

When a step returns, one statement saves its result, inserts the next step's job, and advances the run. Because it is one statement, there is no state where the result exists but the next job does not. The next step's job carries the key `wf:<run>:<step>`, so a re-run cannot insert it twice.

A step has the same at-least-once rule as a job. If the process dies before the finishing statement, the step body runs again. If it dies after the statement but before the step job is marked done, the step job is rescued, the worker sees the saved result, skips the body, and re-issues the finishing statement, which does nothing new. Only the first case re-runs your code.

A step that is discarded marks the run `failed`. A cancelled step marks it `cancelled`. `Treadle.retry` on the step job, or the dashboard's retry, reopens the run at that step. `Treadle.cancelWorkflow(runId)` cancels the current step and the run.

There is no automatic compensation. If step three fails for good and step two moved money, you write the reversal, either inside the step before rethrowing, or from a periodic sweep over failed runs. [The withdrawal use case](use-cases/withdrawal-pipeline.md) shows both.

## What is not guaranteed

- Exactly-once execution. See above.
- Ordering between jobs. Two jobs in one queue with equal priority run in `run_at` order, but with several workers they run concurrently and may finish in any order. Use a workflow for steps that must be sequential.
- Delivery within the poll interval. A worker polls every second by default, so a job enqueued now starts within about a second when a worker is idle.
