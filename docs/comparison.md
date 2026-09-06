# When to use treadle, and when not to

## What treadle is for

An application on Bun with a Postgres database that needs background work to be reliable: it must not be lost when a process dies, must not run for data that rolled back, and must retry sensibly. Multi-step processes that must resume where they stopped. Teams that would rather run one database than a database plus a queue.

## Compared with

**BullMQ, Sidekiq-style queues on Redis.** Faster at raw throughput, tens of thousands of jobs per second per node against treadle's few thousand. But the job lives in Redis and your data lives in Postgres, so an enqueue is a second write that can be lost or orphaned. Redis persistence is also weaker than Postgres by default. Choose Redis queues when throughput is the constraint and losing the occasional job is acceptable, or when you already run Redis and have solved the dual write elsewhere.

**pg-boss, Graphile Worker.** Postgres queues for Node. Same design family as treadle: `SKIP LOCKED`, jobs in your database. They are mature and Node-native. Treadle exists because it is Bun-native with no runtime dependencies, ships step workflows in the same table, and finishes every job in a single statement. If you are on Node, use one of those.

**River.** A Postgres queue for Go, and the closest design relative. Treadle's claim query and rescue model follow River's. If your workers are Go, use River.

**Temporal, Inngest, Trigger.dev.** Durable execution platforms. Their workflow model is far more expressive: a workflow is ordinary code, replayed from an event history, with signals, timers, and child workflows. They are also a service to run or pay for, and the programming model has rules of its own. Treadle's step workflows cover the common shape, a fixed sequence of steps with results passed forward, without a new system. If you need branching, waiting on external signals, or workflows that run for weeks, use one of those.

**Cron and a script.** For work that runs on a schedule and can be re-run from scratch, cron is fine. Treadle's periodic jobs add retries, a record of each run, and a place to see failures.

## When not to use treadle

- Not on Bun. It uses Bun's SQL client and will not run on Node or Deno.
- Not on Postgres.
- Sustained throughput above a few thousand jobs per second on one database, or very short jobs where the claim round trip dominates. Measure first; the [numbers](../README.md#numbers) are for empty handlers.
- Workflows that branch, wait for external events, or fan out and join. Model those as jobs that enqueue other jobs, or use a durable execution platform.
- Strict ordering across jobs. Treadle orders within a queue but runs concurrently.
