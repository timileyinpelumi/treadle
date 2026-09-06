# Order fulfilment

**For:** e-commerce and marketplaces. Reserve stock, take payment, ship, and undo the right things when a step fails.

**Code:** [examples/order-fulfilment.ts](../../examples/order-fulfilment.ts)

## The problem

Placing an order touches inventory, a payment provider, and a shipping provider. Each can fail. Charging a card and then failing to ship needs a refund. Reserving stock and then failing to charge needs the reservation released. Doing this in a request handler with try/catch works until the process dies mid-way.

## The shape

A workflow with a step per system, and compensation written where it belongs.

Reserving stock is made safe to repeat with a conditional update and a reservations table keyed on order and SKU, so a re-run after a crash neither double-reserves nor fails:

```ts
const rows = await sql`
  update stock set reserved = reserved + ${item.qty}
  where sku = ${item.sku} and on_hand - reserved >= ${item.qty}
    and not exists (select 1 from stock_reservations where order_id = ${order.orderId} and sku = ${item.sku})
  returning sku`;
```

Charging returns the charge id as the step result, so the next step can refund it:

```ts
{ name: "charge", run: async (order) => ({ chargeId: await chargeCard(order.orderId, order.amount) }) },
```

Shipping compensates inside the step before rethrowing, so every retry starts clean:

```ts
{ name: "ship", run: async (order, results) => {
    try {
      const shipmentId = await createShipment(order.orderId);
      ...
    } catch (e) {
      await refundCharge(results.charge.chargeId);
      throw e;
    }
} },
```

Refunding on every failed attempt and charging again on the retry is wasteful if the shipping provider is merely slow. The alternative is to refund only from a sweep over `failed` runs, as the [withdrawal](withdrawal-pipeline.md) example does. Which one is right depends on whether a card held for a few minutes is acceptable to you.

## When it fails

Out of stock: `reserve-stock` throws on the first attempt, retries, and is discarded after `maxAttempts`, leaving the run `failed` with the SKU in the error. Nothing was charged because the charge step never ran. Payment declined: the run fails at `charge`, and the stock reservation is still held; release it from a sweep over failed runs, or lower `maxAttempts` for this workflow since declines do not fix themselves.

## What to look at

Failed runs by step name is the useful breakdown: failures at `reserve-stock` are inventory problems, at `charge` are payment problems, at `ship` are carrier problems.
