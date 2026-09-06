# Multi-tenant work

**For:** SaaS products where one customer's load must not degrade another's, and paying customers should go first.

**Code:** [examples/multi-tenant.ts](../../examples/multi-tenant.ts)

## The problem

One tenant triggers a ten thousand row export and every other tenant's password reset email waits behind it. A worker pool shared by all tenants is fair only when the work is.

## The shape

Two tools: queues for kinds of work, priority for who goes first within a kind.

```ts
return treadle.enqueue(tx, name, { tenantId: tenant.id, ...args }, {
  queue: kind,                                  // "interactive" or "batch"
  priority: tenant.plan === "pro" ? 0 : 10,
});
```

A worker on `["interactive", "batch"]` drains interactive jobs first and only takes batch work when nothing interactive is waiting. Within a queue, pro tenants' jobs come before free tenants'. A password reset is interactive, an export is batch, and the export never blocks the reset regardless of who triggered it.

Priority is not a share: a stream of priority 0 jobs starves priority 10 jobs entirely. That is the intended behaviour for pro over free on the same queue. If free tenants need a guaranteed share, give them their own queue and a worker of their own.

For a tenant whose load is a problem, or who pays for isolation, a dedicated queue and worker separates them completely:

```ts
const noisy = new Worker(sql, { queues: ["tenant-acme"], concurrency: 2 });
```

Route that tenant's enqueues to `tenant-acme` and the shared workers never see them.

Every handler scopes its queries by the tenant id in the args. Treadle does not enforce tenant boundaries; the job row is just data.

## Fairness across tenants in one queue

Treadle has no per-tenant fairness. If tenant A enqueues a thousand batch jobs and tenant B enqueues one, B's job waits behind A's thousand at equal priority. Two ways to soften it: enqueue A's jobs with a slightly higher priority number when a tenant already has many waiting, or cap chunks per tenant per interval at enqueue time. Both are enqueue-side policy, which is where fairness belongs.

## When it fails

A tenant's jobs fail for good: `discarded` rows filtered by `args->>'tenantId'` on the dashboard's failures list, or in SQL. Retrying all of one tenant's discarded jobs is one update.

## What to look at

`available` counts per queue on the dashboard show whether interactive work is keeping up. Per-tenant counts come from SQL: `select args->>'tenantId', state, count(*) from treadle.jobs group by 1, 2`.
