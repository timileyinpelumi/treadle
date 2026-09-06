# Withdrawal pipeline

**For:** ledgers, wallets, payouts, anything that moves money in stages.

**Code:** [examples/withdrawal.ts](../../examples/withdrawal.ts)

## The problem

A withdrawal reserves funds, calls a bank, then settles or reverses. Each stage talks to a different system and any of them can fail. Done as one function, a crash after the bank call and before settlement leaves money in flight with no record of which stage was reached. Retrying the whole thing from the start sends the money twice.

## The shape

A three step workflow. Each step's result is saved before the next step starts, so a restart continues from the last saved result.

```ts
worker.registerWorkflow("withdraw", [
  { name: "reserve", run: async (input) => ({ holdId: await reserveFunds(input.accountId, input.amount) }) },
  { name: "send",    run: async (input, results) => {
      const bankRef = await sendToBank(input.accountId, input.amount, input.withdrawalId);
      return { bankRef, holdId: results.reserve.holdId };
  } },
  { name: "settle",  run: async (input, results) => {
      await sql`update withdrawals set state = 'settled', bank_ref = ${results.send.bankRef} where id = ${input.withdrawalId}`;
  } },
]);
```

The request handler records the withdrawal and starts the workflow in one transaction, keyed on the withdrawal id so a double-submitted form starts one run:

```ts
return treadle.startWorkflow(tx, "withdraw", input, {
  queue: "ledger",
  maxAttempts: 5,
  idempotencyKey: `withdraw:${input.withdrawalId}`,
});
```

Each step is still at least once: a crash before the step's result is saved re-runs the step. So each step must be safe to repeat. `reserveFunds` keys the hold on the withdrawal id in your ledger. `sendToBank` passes the withdrawal id as the bank's reference, so the bank rejects or deduplicates a second send. `settle` is a plain update. That discipline is the whole difference between a pipeline that is safe under crashes and one that is not; treadle gives you the resume point, your steps give you the idempotency.

## When it fails

The bank is down: the `send` step throws, its job goes to `retryable`, and the run waits. Five attempts with default backoff is about a minute. If all five fail, the step job is `discarded` and the run is `failed`. Nothing is automatically reversed. The example has a periodic job that finds failed runs, reads the hold id from step zero's saved result, releases the hold, and marks the withdrawal failed:

```ts
worker.register("release-failed-holds", async () => {
  const failed = await sql`
    select r.input->>'withdrawalId' as id, s.result->>'holdId' as hold
    from treadle.workflow_runs r
    join treadle.step_results s on s.workflow_run_id = r.id and s.step_index = 0
    where r.name = 'withdraw' and r.state = 'failed'`;
  ...
});
```

Alternatively, an operator retries the step from the dashboard once the bank is back, and the run continues from `send` with the same hold.

## What to look at

Workflow runs on the dashboard: a `failed` run expands to show which step failed and the bank's error. `stepFinished` events counted by step name give a funnel: reserved, sent, settled. The gap between sent and settled is money in flight.
