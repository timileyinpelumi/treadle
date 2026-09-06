import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/treadle_load";
const leaseMs = Number(process.env.LEASE_MS ?? 5000);
const rescueIntervalMs = Number(process.env.RESCUE_MS ?? 1000);
const runs = Number(process.env.RUNS ?? 5);

const sql = new SQL(url);
await sql`drop schema if exists treadle cascade`;
await migrate(sql);
const treadle = new Treadle(sql);

const results: number[] = [];
for (let i = 0; i < runs; i++) {
  await sql`delete from treadle.jobs`;
  const id = await sql.begin((tx) => treadle.enqueue(tx, "job", {}));

  const child = Bun.spawn(["bun", "scripts/recovery-child.ts"], {
    env: { ...process.env, DATABASE_URL: url, LEASE_MS: String(leaseMs) },
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  const killedAt = performance.now();

  const worker = new Worker(sql, { pollIntervalMs: 50, leaseMs, rescueIntervalMs, onError: () => {} });
  worker.register("job", async () => {});
  await worker.start();
  while ((await sql`select state from treadle.jobs where id = ${id}`)[0]?.state !== "completed") await Bun.sleep(20);
  results.push(performance.now() - killedAt);
  await worker.stop();
}
await sql.end();
const avg = results.reduce((a, b) => a + b, 0) / results.length;
console.log(`lease=${leaseMs}ms rescue=${rescueIntervalMs}ms runs=${runs} recovery avg=${avg.toFixed(0)}ms min=${Math.min(...results).toFixed(0)}ms max=${Math.max(...results).toFixed(0)}ms`);
