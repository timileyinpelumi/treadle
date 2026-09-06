import { SQL } from "bun";
import { migrate, Treadle } from "../src/index";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/treadle_load";
const n = Number(process.env.N ?? 1000);

const sql = new SQL(url, { max: 20 });
await sql`drop schema if exists treadle cascade`;
await migrate(sql);
const treadle = new Treadle(sql);

const t0 = performance.now();
const ids = await Promise.all(
  Array.from({ length: n }, () => sql.begin((tx) => treadle.enqueue(tx, "job", {}, { idempotencyKey: "storm" }))),
);
const ms = performance.now() - t0;
const [row] = await sql`select count(*)::int as n from treadle.jobs`;
await sql.end();
console.log(`concurrent=${n} distinct_ids=${new Set(ids).size} rows=${row!.n} ms=${ms.toFixed(0)}`);
