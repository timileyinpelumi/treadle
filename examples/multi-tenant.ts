import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

// Two queues: interactive work first, batch work when nothing interactive is waiting.
// Within a queue, paying customers go first via priority.
export async function enqueueForTenant(
  tx: SQL,
  tenant: { id: string; plan: "free" | "pro" },
  name: string,
  args: unknown,
  kind: "interactive" | "batch",
): Promise<string> {
  return treadle.enqueue(tx, name, { tenantId: tenant.id, ...(args as object) }, {
    queue: kind,
    priority: tenant.plan === "pro" ? 0 : 10,
  });
}

// Queue order is drain order: a worker on ["interactive", "batch"] takes batch jobs only when interactive is empty.
const worker = new Worker(sql, { queues: ["interactive", "batch"], concurrency: 10 });
worker.register("generate-export", async (args: { tenantId: string }) => {
  // every query scoped by tenantId
});
worker.register("send-digest", async (args: { tenantId: string }) => {});
await worker.start();

// A dedicated worker for one noisy tenant, if it comes to that: give them their own queue.
const noisy = new Worker(sql, { queues: ["tenant-acme"], concurrency: 2 });
noisy.register("generate-export", async () => {});
await noisy.start();
