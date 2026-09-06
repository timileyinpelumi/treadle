# Email after signup

**For:** any application that does something after a write. Welcome emails, notifications, search indexing, audit events.

**Code:** [examples/signup-email.ts](../../examples/signup-email.ts)

## The problem

A signup handler inserts the user and sends a welcome email. Done inline, the request waits on the mail provider and fails when it is down. Done by pushing a message to a queue after the insert, there are two ways to be wrong: the process dies after the insert and before the push, so the email never goes; or the push happens and the insert rolls back, so someone gets a welcome email for an account that does not exist.

## The shape

Enqueue inside the same transaction as the insert.

```ts
export async function signUp(email: string, name: string): Promise<string> {
  return sql.begin(async (tx) => {
    const [user] = await tx`insert into users (email, name) values (${email}, ${name}) returning id::text as id`;
    await treadle.enqueue(tx, "welcome-email", { userId: user!.id }, {
      idempotencyKey: `welcome:${user!.id}`,
    });
    return user!.id as string;
  });
}
```

The job row commits with the user row or not at all. The idempotency key means a retried signup request, or a second code path that also enqueues the welcome, produces one email job.

The handler re-reads the user rather than trusting the args, so a user deleted in the seconds before the job ran gets nothing:

```ts
worker.register("welcome-email", async (args: { userId: string }) => {
  const [user] = await sql`select email, name from users where id = ${args.userId}`;
  if (!user) return;
  await sendEmail(user.email, "welcome", { name: user.name });
});
```

## When it fails

The mail provider is down: the handler throws, the job goes to `retryable`, and comes back after 2, 4, 8 seconds and so on for up to 25 attempts by default. On the dashboard the job appears under recent failures with the provider's error. When the provider recovers, the backlog drains on its own.

The worker process dies after `sendEmail` returned but before treadle recorded completion: the job runs again and the email is sent twice. To close that window, make the send idempotent: most providers accept an idempotency key, and `ctx.jobId` is a good one. Or record the send in your own table first, keyed on the user, and check it before sending.

## What to look at

On the dashboard, the `default` queue's `available` count should hover near zero. A growing count means the worker is down or behind. `discarded` rows with a mail provider error mean a user never got their email; retry them from the dashboard once the provider is back.
