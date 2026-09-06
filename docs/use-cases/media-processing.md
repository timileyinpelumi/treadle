# Long media jobs

**For:** video transcoding, image pipelines, PDF rendering, report generation, anything that takes minutes.

**Code:** [examples/media.ts](../../examples/media.ts)

## The problem

Long jobs stress every assumption a queue makes. A worker that dies ten minutes into a transcode should not lose the job, but the queue should not hand the job to another worker while the first is still healthy either. Users cancel. CPU-bound work blocks the event loop so background timers cannot run.

## The shape

Three settings and two habits.

```ts
const worker = new Worker(sql, {
  queues: ["media"],
  concurrency: 2,
  leaseMs: 5 * 60 * 1000,
  heartbeatMs: 30 * 1000,
});
```

Concurrency matches the cores you want to give to transcoding. The lease is how long a dead worker's job waits before another picks it up: five minutes here, because a spurious re-run of a long job costs more than a few minutes of delay. The heartbeat extends the lease well within it.

Inside the work, call `ctx.heartbeat()` at progress points. The background heartbeat runs on a timer, and a timer cannot fire while synchronous work blocks the event loop; an explicit call from a progress callback keeps the lease alive regardless.

```ts
worker.register("transcode", async (args, ctx) => {
  const output = await transcode(args.path, async (pct) => {
    await ctx.heartbeat();
    await sql`update videos set progress = ${pct} where id = ${args.videoId}`;
  }, ctx.signal);
  if (ctx.signal.aborted) return;
  await sql`update videos set output_path = ${output}, progress = 100 where id = ${args.videoId}`;
});
```

Pass `ctx.signal` into the work. When a user cancels, `Treadle.cancel(jobId)` sets a flag, the next heartbeat sees it and aborts the signal, and a transcoder that honours the signal stops within one heartbeat. The job ends as `cancelled` whatever the handler returns.

Idempotency: `transcode:${videoId}` on enqueue means a double-clicked upload button creates one job. The output path is deterministic from the video id, so a re-run after a crash overwrites rather than duplicates.

## When it fails

The worker is killed mid-transcode: the job keeps its lease for up to five minutes, then the rescuer returns it and another worker starts over, with `attempt` one higher, so a job whose worker keeps dying is eventually discarded rather than retried forever. Progress in your own table restarts from zero. If starting over is too expensive, have the transcoder checkpoint to disk keyed on the video id and resume; the job system cannot do that for you.

The transcoder throws: normal retry with backoff, three attempts here, then discarded with the error for the dashboard.

## What to look at

`running` jobs in the `media` queue with `started_at` far in the past and a recent `lease_until` are healthy long jobs. Ones with an expired `lease_until` are waiting for rescue. `leaseLost` events mean a worker's heartbeat fell behind the lease, which points at blocked event loops or a lease set too short.
