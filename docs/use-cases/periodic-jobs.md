# Periodic and scheduled jobs

**For:** reports, cleanup, syncs, reminders, anything that runs on a clock.

**Code:** [examples/periodic.ts](../../examples/periodic.ts)

## The problem

Cron runs a script. If the script fails, cron does not retry; if the machine is down at the minute, the run is skipped; if two machines have the same crontab, it runs twice; and there is no record of what happened. Reminders that should fire once at a time in the future do not fit cron at all.

## The shape

A periodic job is an ordinary enqueue with `every`. After each run completes or is discarded, treadle inserts the next occurrence with `run_at` advanced by the interval. Register at deploy time with an idempotency key so the chain is created once no matter how many processes start:

```ts
await treadle.enqueue(tx, "daily-report", {}, {
  every: 24 * 60 * 60 * 1000,
  runAt: nextMidnightUtc(),
  idempotencyKey: "periodic:daily-report",
});
```

Each occurrence is its own row with its own retries and error, so a report that fails at 00:00 is retried with backoff and shows on the dashboard, and the next one still runs at 00:00 tomorrow.

A scheduled one-off is `runAt` without `every`:

```ts
return treadle.enqueue(tx, "reminder", { userId }, { runAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
```

The handler checks whether the reminder is still wanted, since the user may have acted in the meantime.

Housekeeping for treadle itself is a periodic job too:

```ts
worker.register("purge-old-jobs", async () => {
  await sql`delete from treadle.jobs where state in ('completed', 'cancelled') and finished_at < now() - interval '7 days'`;
});
```

## What periodic jobs do not do

- Cron expressions. `every` is a fixed interval from the previous run's finish. For "every day at 00:00" set `runAt` to the first midnight and `every` to 24 hours; drift is one run's duration per day. If exact wall-clock alignment matters, have the handler compute the next `runAt` and enqueue it, and drop `every`.
- Catch-up. If workers are down for three intervals, the next occurrence runs once when they return, not three times.
- Overlap protection beyond the chain. The next occurrence is only inserted when the current one finishes, so two occurrences of one chain never run at once.

## When it fails

A periodic job that fails every time is discarded each occurrence and re-inserted for the next interval, so the chain keeps ticking and the dashboard keeps showing it under recent failures. To stop a chain, cancel its `available` occurrence from the dashboard or with `Treadle.cancel`.

## What to look at

The `available` job for each chain, with its `run_at`, is the schedule. A chain with no `available` row has stopped: either its last occurrence was cancelled, or a bug in the finishing path, which would be a treadle bug worth reporting.
