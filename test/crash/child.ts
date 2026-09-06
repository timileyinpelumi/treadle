import { SQL } from "bun";
import { Worker } from "../../src/index";

const point = process.env.CRASH_AT!;
const sql = new SQL(process.env.DATABASE_URL!);
const die = () => process.kill(process.pid, "SIGKILL");

if (point === "before-claim") die();

const effect = (phase: string, jobId: string) =>
  sql`insert into crash_effects (point, phase, job_id) values (${point}, ${phase}, ${jobId}::bigint)`;

const worker = new Worker(sql, {
  pollIntervalMs: 20,
  leaseMs: 500,
  heartbeatMs: 100,
  rescueIntervalMs: 60_000,
  onEvent: (event) => { if (event === point) die(); },
});

worker.register("job", async (_args, ctx) => {
  await effect("handler-start", ctx.jobId);
  if (point === "mid-handler") die();
  await effect("handler-end", ctx.jobId);
});

worker.registerWorkflow("wf", [
  { name: "first", run: async (_i, _r, ctx) => { await effect("step-first", ctx.jobId); return { x: 1 }; } },
  { name: "second", run: async (_i, results, ctx) => { await effect("step-second", ctx.jobId); return results; } },
]);

await worker.start();
// Safety net: a point that never fires must not leave the child running forever.
setTimeout(() => process.exit(0), 5000);
