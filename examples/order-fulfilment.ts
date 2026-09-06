import { SQL } from "bun";
import { migrate, Treadle, Worker } from "../src/index";
import { chargeCard, createShipment, refundCharge } from "./_stubs";

const sql = new SQL(process.env.DATABASE_URL!);
await migrate(sql);
const treadle = new Treadle(sql);

type Order = { orderId: string; amount: number; items: { sku: string; qty: number }[] };

export async function placeOrder(order: Order): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`insert into orders (id, amount, state) values (${order.orderId}, ${order.amount}, 'placed')`;
    await treadle.startWorkflow(tx, "fulfil", order, { queue: "orders", idempotencyKey: `fulfil:${order.orderId}` });
  });
}

const worker = new Worker(sql, { queues: ["orders"] });
worker.registerWorkflow("fulfil", [
  {
    name: "reserve-stock",
    run: async (order: Order) => {
      // One statement per line item; the where clause makes it safe to run twice.
      for (const item of order.items) {
        const rows = await sql`
          update stock set reserved = reserved + ${item.qty}
          where sku = ${item.sku} and on_hand - reserved >= ${item.qty}
            and not exists (select 1 from stock_reservations where order_id = ${order.orderId} and sku = ${item.sku})
          returning sku`;
        if (rows.length === 1) {
          await sql`insert into stock_reservations (order_id, sku, qty) values (${order.orderId}, ${item.sku}, ${item.qty})`;
        } else if ((await sql`select 1 from stock_reservations where order_id = ${order.orderId} and sku = ${item.sku}`).length === 0) {
          throw new Error(`out of stock: ${item.sku}`);
        }
      }
    },
  },
  {
    name: "charge",
    run: async (order: Order) => ({ chargeId: await chargeCard(order.orderId, order.amount) }),
  },
  {
    name: "ship",
    run: async (order: Order, results) => {
      try {
        const shipmentId = await createShipment(order.orderId);
        await sql`update orders set state = 'shipped', shipment_id = ${shipmentId} where id = ${order.orderId}`;
        return { shipmentId };
      } catch (e) {
        // Compensate before letting the step fail so the retry starts from a clean slate.
        await refundCharge((results.charge as { chargeId: string }).chargeId);
        throw e;
      }
    },
  },
]);
await worker.start();
