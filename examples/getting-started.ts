import { SQL } from "bun";
import { dashboard, migrate, Treadle, Worker } from "../src/index";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

// 1. Enqueue inside your own transaction.
await sql.begin(async (tx) => {
  await tx`insert into users (email) values (${"a@example.com"})`;
  await treadle.enqueue(tx, "welcome-email", { email: "a@example.com" });
});

// 2. Run a worker. One process can run many; each claims jobs it has handlers for.
const worker = new Worker(sql, { queues: ["default"], concurrency: 10 });
worker.register("welcome-email", async (args: { email: string }, ctx) => {
  console.log(`sending to ${args.email}, attempt ${ctx.attempt}`);
});
await worker.start();

// 3. Serve the dashboard behind your own auth.
Bun.serve({ port: 3000, fetch: dashboard(sql, { basePath: "/admin/jobs" }) });

// 4. Stop cleanly on SIGTERM so in-flight jobs finish.
process.on("SIGTERM", async () => {
  await worker.stop();
  await sql.end();
  process.exit(0);
});
