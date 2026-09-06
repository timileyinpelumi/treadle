import { SQL } from "bun";
import { claimJobs } from "../src/queries";
import { migrate } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/treadle_load";
const rows = Number(process.env.ROWS ?? 100_000);
const samples = Number(process.env.SAMPLES ?? 200);

const sql = new SQL(url);
await sql`drop schema if exists treadle cascade`;
await migrate(sql);

// generate_series is far faster than one insert per row for seeding.
await sql`
  insert into treadle.jobs (queue, name, args, state, finished_at)
  select 'default', 'seed', '{}'::jsonb, 'completed', now() from generate_series(1, ${rows - 1000})`;
await sql`
  insert into treadle.jobs (queue, name, args)
  select 'default', 'claim', '{}'::jsonb from generate_series(1, 1000)`;
await sql`analyze treadle.jobs`;

const times: number[] = [];
for (let i = 0; i < samples; i++) {
  const t0 = performance.now();
  await claimJobs(sql, { queues: ["default"], names: ["claim"], limit: 1, leaseMs: 30_000, workerId: "bench" });
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(2);
await sql.end();
console.log(`rows=${rows} samples=${samples} p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms`);
