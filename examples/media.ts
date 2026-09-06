import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";
import { transcode } from "./_stubs";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

export async function uploadVideo(tx: SQL, videoId: string, path: string): Promise<string> {
  return treadle.enqueue(tx, "transcode", { videoId, path }, { queue: "media", maxAttempts: 3, idempotencyKey: `transcode:${videoId}` });
}

// Long jobs: a long lease, a heartbeat inside the work, and a handler that honours cancel.
const worker = new Worker(sql, {
  queues: ["media"],
  concurrency: 2,           // transcoding is CPU bound; more would only contend
  leaseMs: 5 * 60 * 1000,   // an orphaned job is retried within five minutes
  heartbeatMs: 30 * 1000,
});
worker.register("transcode", async (args: { videoId: string; path: string }, ctx) => {
  const output = await transcode(
    args.path,
    async (pct) => {
      await ctx.heartbeat(); // extend the lease from inside long-running work
      await sql`update videos set progress = ${pct} where id = ${args.videoId}`;
    },
    ctx.signal, // aborted when someone cancels the job or the lease is lost
  );
  if (ctx.signal.aborted) return; // cancelled; the job ends as cancelled regardless of what we return
  await sql`update videos set output_path = ${output}, progress = 100 where id = ${args.videoId}`;
});
await worker.start();

// Cancel from a request handler. A running job sees the abort within one heartbeat.
export async function cancelTranscode(jobId: string): Promise<boolean> {
  return treadle.cancel(jobId);
}
