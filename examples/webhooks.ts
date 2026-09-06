import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";
import { postWebhook } from "./_stubs";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

// Emit an event. Each subscriber gets its own job so one slow endpoint cannot hold up the others.
export async function emitEvent(tx: SQL, event: { id: string; type: string; payload: unknown }): Promise<void> {
  const subscribers = await tx`select id::text as id, url from webhook_subscriptions where event_type = ${event.type}`;
  for (const sub of subscribers) {
    await treadle.enqueue(tx, "deliver-webhook", { subscriptionId: sub.id, url: sub.url, event }, {
      queue: "webhooks",
      maxAttempts: 8, // 2s, 4s, 8s ... about 4 minutes of retries, then discarded
      idempotencyKey: `webhook:${event.id}:${sub.id}`,
    });
  }
}

const worker = new Worker(sql, { queues: ["webhooks"], concurrency: 20 });
worker.register("deliver-webhook", async (args: { url: string; event: { id: string } }, ctx) => {
  const res = await postWebhook(args.url, { ...args.event, attempt: ctx.attempt });
  // 4xx other than 429 will not get better with retries; return so the job completes.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    await sql`insert into webhook_failures (event_id, url, status) values (${args.event.id}, ${args.url}, ${res.status})`;
    return;
  }
  // 5xx and 429: throw, and treadle retries with backoff.
  if (res.status >= 400) throw new Error(`endpoint returned ${res.status}`);
});
await worker.start();
