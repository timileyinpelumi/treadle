# Webhook delivery

**For:** products that notify customers' servers about events. SaaS, payment platforms, anything with an integrations page.

**Code:** [examples/webhooks.ts](../../examples/webhooks.ts)

## The problem

Customer endpoints are slow, down, or wrong, and none of that should slow your own writes or hold up other customers. Deliveries need retries with backoff, a limit, and a record of what gave up so support can answer "why didn't we get the event".

## The shape

One job per event per subscriber. A slow endpoint then holds up only its own jobs.

```ts
export async function emitEvent(tx: SQL, event: { id: string; type: string; payload: unknown }): Promise<void> {
  const subscribers = await tx`select id::text as id, url from webhook_subscriptions where event_type = ${event.type}`;
  for (const sub of subscribers) {
    await treadle.enqueue(tx, "deliver-webhook", { subscriptionId: sub.id, url: sub.url, event }, {
      queue: "webhooks",
      maxAttempts: 8,
      idempotencyKey: `webhook:${event.id}:${sub.id}`,
    });
  }
}
```

`maxAttempts: 8` with the default backoff retries over roughly four minutes, then discards. The idempotency key stops a re-emitted event from creating duplicate deliveries.

The handler decides what counts as a failure. A 4xx other than 429 is the customer's problem and will not improve with retries, so the handler records it and returns, which completes the job. A 5xx or 429 throws, and treadle retries.

```ts
worker.register("deliver-webhook", async (args, ctx) => {
  const res = await postWebhook(args.url, { ...args.event, attempt: ctx.attempt });
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    await sql`insert into webhook_failures (event_id, url, status) values (${args.event.id}, ${args.url}, ${res.status})`;
    return;
  }
  if (res.status >= 400) throw new Error(`endpoint returned ${res.status}`);
});
```

A dedicated `webhooks` queue with its own worker at higher concurrency keeps outbound HTTP from taking slots from your other jobs.

## When it fails

The endpoint stays down past the last attempt: the job is `discarded` with the last status in `last_error`. It stays in the table, so it is your dead letter record. Support can find it by event id, and retry it from the dashboard once the customer fixes their endpoint. Bulk retry after an outage is one query: `update treadle.jobs set state = 'available', attempt = 0, run_at = now(), finished_at = null where state = 'discarded' and name = 'deliver-webhook' and args->'event'->>'type' = 'invoice.paid'`, or a loop over `Treadle.retry`.

Send `ctx.attempt` in the payload so the receiver can tell a retry from a new event, and include the event id so they can deduplicate.

## What to look at

Recent failures on the dashboard, grouped by URL, tells you which customer is down. A rising `retryable` count in the `webhooks` queue means many endpoints are failing at once, which usually means the problem is on your side.
