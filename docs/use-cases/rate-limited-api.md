# Calling a rate-limited API

**For:** embeddings and LLM calls, third-party APIs with concurrency or per-minute limits, anything that answers 429.

**Code:** [examples/ai-api.ts](../../examples/ai-api.ts)

## The problem

The provider allows four requests in flight and returns 429 beyond that. Your application enqueues thousands of documents to embed. Without a cap the workers hammer the API, everything gets 429, and the retries make it worse.

## The shape

The worker's `concurrency` is the cap. Run one worker process for the queue so the cap is global rather than per process:

```ts
const worker = new Worker(sql, {
  queues: ["embeddings"],
  concurrency: 4,
  backoff: (attempt) => Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 500,
});
```

A custom backoff that starts short and caps at 30 seconds suits rate limits better than the default, which climbs to an hour. On a 429 the handler throws and the job comes back after the backoff; `maxAttempts: 10` on enqueue gives it a few minutes to find a gap.

The handler writes results in its own transaction, deleting the old vectors first, so a re-run replaces rather than appends:

```ts
await sql.begin(async (tx) => {
  await tx`delete from embeddings where doc_id = ${args.docId}`;
  for (let i = 0; i < vectors.length; i++) {
    await tx`insert into embeddings (doc_id, position, vector) values (${args.docId}, ${i}, ...)`;
  }
});
```

`embed:${docId}` as the idempotency key means re-indexing a document that is already queued does nothing. A document edited after its job ran needs a new key, such as `embed:${docId}:${version}`.

If the provider tells you how long to wait, honour it: catch the rate limit error, and instead of throwing, re-enqueue with `runAt` set to now plus `retryAfterMs` and return. That costs one extra row and gets the timing right.

## Per-provider queues

One queue per provider, each with its own worker and concurrency, keeps a slow provider from filling the slots of a fast one. A queue per API key, if you have several, is the same idea.

## When it fails

The provider is down for an hour: every job retries to its limit and is discarded. After the outage, bulk retry: `update treadle.jobs set state = 'available', attempt = 0, run_at = now(), finished_at = null where state = 'discarded' and name = 'embed'`. Because the handler is idempotent, retrying a job that half-succeeded is safe.

## What to look at

`failed` events by error message: a rising share of rate limit errors means the concurrency cap is too high for the provider's real limit, or another process is using the same quota. The `retryable` count in the queue is the backlog waiting on backoff.
