import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";
import { buildReport, upload } from "./_stubs";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

// Register periodic jobs once at deploy time. The idempotency key makes the enqueue a no-op if the chain already exists.
await sql.begin(async (tx) => {
  await treadle.enqueue(tx, "daily-report", {}, {
    every: 24 * 60 * 60 * 1000,
    runAt: nextMidnightUtc(),
    idempotencyKey: "periodic:daily-report",
  });
  await treadle.enqueue(tx, "purge-old-jobs", {}, {
    every: 60 * 60 * 1000,
    idempotencyKey: "periodic:purge-old-jobs",
  });
});

// A one-off scheduled job: send a reminder in 24 hours unless the user acted first.
export async function scheduleReminder(tx: SQL, userId: string): Promise<string> {
  return treadle.enqueue(tx, "reminder", { userId }, { runAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
}

const worker = new Worker(sql, { queues: ["default"] });
worker.register("daily-report", async () => {
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await upload(`reports/${day}.csv`, await buildReport(day));
});
worker.register("purge-old-jobs", async () => {
  await sql`delete from treadle.jobs where state in ('completed', 'cancelled') and finished_at < now() - interval '7 days'`;
});
worker.register("reminder", async (args: { userId: string }) => {
  const [u] = await sql`select acted from users where id = ${args.userId}`;
  if (!u || u.acted) return;
  // send it
});
await worker.start();

function nextMidnightUtc(): Date {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}
