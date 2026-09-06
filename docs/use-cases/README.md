# Use cases

Worked examples, one per kind of work. Each says who it is for, what goes wrong without a job system, how to shape it with treadle, and what to look at when it fails. Every code sample is a runnable file under [examples/](../../examples/) that the project typechecks.

| Use case | For | Uses |
|---|---|---|
| [Email after signup](signup-email.md) | any web app | the outbox, idempotency keys |
| [Webhook delivery](webhook-delivery.md) | SaaS and API products | retries, backoff, discard, the dashboard |
| [Withdrawal pipeline](withdrawal-pipeline.md) | fintech, ledgers | step workflows, compensation |
| [Order fulfilment](order-fulfilment.md) | e-commerce | step workflows, compensating inside a step |
| [Periodic jobs](periodic-jobs.md) | ops, data, reporting | periodic and scheduled jobs |
| [Long media jobs](media-processing.md) | video, images, rendering | leases, heartbeat, cancel |
| [Bulk import](bulk-import.md) | data pipelines | fan-out, idempotency keys, priorities |
| [Rate-limited APIs](rate-limited-api.md) | AI and third-party integrations | concurrency caps, custom backoff |
| [Multi-tenant work](multi-tenant.md) | SaaS | queues, priorities, isolation |
