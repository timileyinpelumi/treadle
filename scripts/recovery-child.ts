import { SQL } from "bun";
import { Worker } from "../src/index";

const sql = new SQL(process.env.DATABASE_URL!);
const worker = new Worker(sql, {
  pollIntervalMs: 20,
  leaseMs: Number(process.env.LEASE_MS),
  rescueIntervalMs: 60_000,
  onEvent: (event) => { if (event === "claimed") process.kill(process.pid, "SIGKILL"); },
});
worker.register("job", async () => {});
await worker.start();
setTimeout(() => process.exit(1), 5000);
