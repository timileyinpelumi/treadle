import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";
import { chunk } from "./_stubs";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

// Fan out: one job per chunk, keyed so a re-run of the import enqueues nothing new.
export async function startImport(importId: string, rows: { email: string }[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`insert into imports (id, total_chunks, done_chunks) values (${importId}, ${Math.ceil(rows.length / 500)}, 0)`;
    let i = 0;
    for (const part of chunk(rows, 500)) {
      await treadle.enqueue(tx, "import-chunk", { importId, index: i, rows: part }, {
        queue: "imports",
        priority: 5,                       // below interactive work in the same queue
        idempotencyKey: `import:${importId}:${i}`,
      });
      i++;
    }
  });
}

const worker = new Worker(sql, { queues: ["imports"], concurrency: 4 });
worker.register("import-chunk", async (args: { importId: string; index: number; rows: { email: string }[] }) => {
  // on conflict makes the chunk safe to run twice.
  for (const r of args.rows) {
    await sql`insert into contacts (import_id, email) values (${args.importId}, ${r.email}) on conflict (email) do nothing`;
  }
  // Mark this chunk done exactly once, then finish the import when the last one lands.
  const rows = await sql`
    insert into import_chunks_done (import_id, index) values (${args.importId}, ${args.index})
    on conflict do nothing returning index`;
  if (rows.length === 1) {
    await sql`
      update imports set done_chunks = done_chunks + 1,
        finished_at = case when done_chunks + 1 = total_chunks then now() else finished_at end
      where id = ${args.importId}`;
  }
});
await worker.start();
