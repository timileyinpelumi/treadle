import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";
import { releaseHold, reserveFunds, sendToBank } from "./_stubs";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

type Input = { withdrawalId: string; accountId: string; amount: number };

// Request side: record the withdrawal and start the workflow in one transaction.
export async function requestWithdrawal(input: Input): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`insert into withdrawals (id, account_id, amount, state) values (${input.withdrawalId}, ${input.accountId}, ${input.amount}, 'pending')`;
    return treadle.startWorkflow(tx, "withdraw", input, {
      queue: "ledger",
      maxAttempts: 5,
      idempotencyKey: `withdraw:${input.withdrawalId}`,
    });
  });
}

const worker = new Worker(sql, { queues: ["ledger"], concurrency: 5 });
worker.registerWorkflow("withdraw", [
  {
    name: "reserve",
    run: async (input: Input) => {
      // Idempotent by design: reserveFunds keys the hold on withdrawalId in your ledger.
      const holdId = await reserveFunds(input.accountId, input.amount);
      return { holdId };
    },
  },
  {
    name: "send",
    run: async (input: Input, results) => {
      // The bank reference is the withdrawal id, so a re-run after a crash is a no-op at the bank.
      const bankRef = await sendToBank(input.accountId, input.amount, input.withdrawalId);
      return { bankRef, holdId: (results.reserve as { holdId: string }).holdId };
    },
  },
  {
    name: "settle",
    run: async (input: Input, results) => {
      const { bankRef } = results.send as { bankRef: string };
      await sql`update withdrawals set state = 'settled', bank_ref = ${bankRef} where id = ${input.withdrawalId}`;
    },
  },
]);

// A discarded step marks the run failed. Compensate from a periodic sweep, or from the dashboard's retry.
worker.register("release-failed-holds", async () => {
  const failed = await sql`
    select r.input->>'withdrawalId' as id, s.result->>'holdId' as hold
    from treadle.workflow_runs r
    join treadle.step_results s on s.workflow_run_id = r.id and s.step_index = 0
    where r.name = 'withdraw' and r.state = 'failed'`;
  for (const f of failed) {
    await releaseHold(f.hold);
    await sql`update withdrawals set state = 'failed' where id = ${f.id} and state = 'pending'`;
  }
});
await worker.start();
