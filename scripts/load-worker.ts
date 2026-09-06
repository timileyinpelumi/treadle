import { SQL } from "bun";
import { Worker } from "../src/index";

const sql = new SQL(process.env.DATABASE_URL!);
const worker = new Worker(sql, {
  concurrency: Number(process.env.CONCURRENCY ?? 10),
  pollIntervalMs: 50,
  onError: () => {},
});
worker.register("load", async () => {});
await worker.start();
process.on("SIGTERM", async () => {
  await worker.stop();
  await sql.end();
  process.exit(0);
});
