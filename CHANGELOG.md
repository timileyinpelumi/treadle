# Changelog

## 0.1.0

First release.

- Jobs with queues, priorities, scheduled `runAt`, idempotency keys, and periodic `every`.
- Workers with concurrent claiming via `skip locked`, leases, heartbeats, rescue of expired leases, exponential backoff with jitter, discard after `maxAttempts`, cooperative cancel, graceful stop.
- Step workflows with persisted results, resume at the first unfinished step, run state following the step job, `cancelWorkflow`.
- Dashboard as a fetch handler with retry and cancel.
- `onEvent` and `onError` hooks.
- Schema migration 1: `treadle.jobs`, `treadle.workflow_runs`, `treadle.step_results`, `treadle.migrations`.

Bun 1.3 or later, Postgres 12 or later.
