import { SQL } from "bun";
import { migrate, Treadle } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/treadle_load";
const workers = Number(process.env.WORKERS ?? 1);
const jobs = Number(process.env.JOBS ?? 5000);
const concurrency = Number(process.env.CONCURRENCY ?? 10);

const admin = new SQL(new URL("/postgres", url).toString());
const name = new URL(url).pathname.slice(1);
if ((await admin`select 1 from pg_database where datname = ${name}`).length === 0) {
  await admin.unsafe(`create database "${name}"`);
}
await admin.end();

const sql = new SQL(url);
await sql`drop schema if exists treadle cascade`;
await migrate(sql);
const treadle = new Treadle(sql);

await sql.begin(async (tx) => {
  for (let i = 0; i < jobs; i++) await treadle.enqueue(tx, "load", { i });
});

const procs = Array.from({ length: workers }, () =>
  Bun.spawn(["bun", "scripts/load-worker.ts"], {
    env: { ...process.env, DATABASE_URL: url, CONCURRENCY: String(concurrency) },
    stdout: "ignore",
    stderr: "inherit",
  }),
);

const t0 = performance.now();
let done = 0;
while (done < jobs) {
  await Bun.sleep(100);
  const [row] = await sql`select count(*)::int as n from treadle.jobs where state = 'completed'`;
  done = row!.n as number;
}
const seconds = (performance.now() - t0) / 1000;

for (const p of procs) p.kill("SIGTERM");
await Promise.all(procs.map((p) => p.exited));
await sql.end();

console.log(`workers=${workers} concurrency=${concurrency} jobs=${jobs} seconds=${seconds.toFixed(2)} jobs/s=${(jobs / seconds).toFixed(0)}`);
