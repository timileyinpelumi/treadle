import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";
import { embed, RateLimitError } from "./_stubs";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

export async function indexDocument(tx: SQL, docId: string, passages: string[]): Promise<void> {
  await treadle.enqueue(tx, "embed", { docId, passages }, { queue: "embeddings", maxAttempts: 10, idempotencyKey: `embed:${docId}` });
}

// The provider allows a fixed number of concurrent requests. Concurrency on the worker is the cap;
// run one worker process for this queue so the cap is global.
const worker = new Worker(sql, {
  queues: ["embeddings"],
  concurrency: 4,
  backoff: (attempt) => Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 500,
});
worker.register("embed", async (args: { docId: string; passages: string[] }, ctx) => {
  try {
    const vectors = await embed(args.passages);
    await sql.begin(async (tx) => {
      await tx`delete from embeddings where doc_id = ${args.docId}`;
      for (let i = 0; i < vectors.length; i++) {
        await tx`insert into embeddings (doc_id, position, vector) values (${args.docId}, ${i}, ${JSON.stringify(vectors[i])}::text::jsonb)`;
      }
    });
  } catch (e) {
    if (e instanceof RateLimitError) {
      // Let the backoff handle spacing; the attempt number keeps rising so the wait grows.
      throw new Error(`rate limited on attempt ${ctx.attempt}`);
    }
    throw e;
  }
});
await worker.start();
