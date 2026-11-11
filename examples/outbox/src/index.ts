import { defineStep, defineWorkflow, rollbackQuietly, startWorkflow, type Pool } from "@dee/core";

/**
 * One line of an order.
 */
export interface OrderLine {
  readonly sku: string;
  readonly quantity: number;
}

/**
 * An order the application stores in its own tables.
 */
export interface Order {
  readonly id: string;
  readonly customer: string;
  readonly lines: readonly OrderLine[];
}

/**
 * The input of the `outbox.fulfil-order` workflow.
 */
export interface FulfilOrderInput {
  readonly orderId: string;
}

/**
 * The result of the `outbox.fulfil-order` workflow.
 */
export interface FulfilOrderResult {
  readonly orderId: string;
  readonly reservation: string;
  readonly confirmation: string;
}

/**
 * The workflow type an order starts.
 */
export const FULFIL_ORDER = "outbox.fulfil-order";

/**
 * Reserves the stock of an order and sends its confirmation, each as a
 * step. It is started in the same transaction as the order row, so an order
 * that exists always has a fulfilment and a rolled-back order never has one.
 */
export const fulfilOrder = defineWorkflow<FulfilOrderInput, FulfilOrderResult>(
  FULFIL_ORDER,
  async (ctx, input) => {
    const reservation = await ctx.step<string>("outbox.reserve-stock", input);
    const confirmation = await ctx.step<string>("outbox.send-confirmation", input);
    return { orderId: input.orderId, reservation, confirmation };
  },
);

/**
 * Reserves stock for an order. Keyed by the order id, so running it twice
 * reserves once.
 */
export const reserveStock = defineStep<FulfilOrderInput, string>("outbox.reserve-stock", {
  handler: ({ orderId }) => `reservation:${orderId}`,
});

/**
 * Sends the confirmation of an order.
 */
export const sendConfirmation = defineStep<FulfilOrderInput, string>("outbox.send-confirmation", {
  handler: ({ orderId }) => `confirmation:${orderId}`,
});

/**
 * The workflows this module contributes to `wf dev --module`.
 */
export const workflows = [fulfilOrder];

/**
 * The steps this module contributes to `wf dev --module`.
 */
export const steps = [reserveStock, sendConfirmation];

/**
 * Creates the application's own tables, `orders` and `order_lines`, in the
 * schema `pool` points at. A line needs a positive quantity.
 */
export async function createOrderTables(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists orders (
      id text primary key,
      customer text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists order_lines (
      order_id text not null references orders (id),
      sku text not null,
      quantity integer not null check (quantity > 0),
      primary key (order_id, sku)
    );
  `);
}

/**
 * Where `placeOrder` finds the engine: `engineSchema` is the schema the
 * engine tables were migrated into (for example `dee`).
 */
export interface PlaceOrderOptions {
  readonly engineSchema: string;
}

/**
 * Inserts the order, starts its `outbox.fulfil-order` run and inserts its
 * lines, all in one transaction on a client from `pool`. If any of it fails
 * (a line with a quantity of zero, a duplicate order id) the transaction
 * rolls back and no run, event or task is left behind. Returns the run id.
 */
export async function placeOrder(
  pool: Pool,
  order: Order,
  options: PlaceOrderOptions,
): Promise<string> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    await client.query("insert into orders (id, customer) values ($1, $2)", [
      order.id,
      order.customer,
    ]);
    const started = await startWorkflow(client, {
      workflowType: FULFIL_ORDER,
      input: { orderId: order.id } satisfies FulfilOrderInput,
      idempotencyKey: `order:${order.id}`,
      schema: options.engineSchema,
    });
    for (const line of order.lines) {
      await client.query("insert into order_lines (order_id, sku, quantity) values ($1, $2, $3)", [
        order.id,
        line.sku,
        line.quantity,
      ]);
    }
    await client.query("commit");
    return started.runId;
  } catch (error) {
    broken = !(await rollbackQuietly(client));
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * The other way in: a trigger on `orders` that calls the engine's SQL
 * function `start_workflow`, so an order inserted by any client, in any
 * language, starts its fulfilment in the inserting transaction.
 */
export async function installOrderTrigger(pool: Pool, engineSchema: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(engineSchema)) {
    throw new RangeError(`engineSchema must be a plain identifier, got "${engineSchema}"`);
  }
  await pool.query(`
    create or replace function orders_start_fulfilment() returns trigger language plpgsql as $$
    begin
      perform "${engineSchema}".start_workflow(
        '${FULFIL_ORDER}',
        jsonb_build_object('orderId', new.id),
        idempotency_key => 'order:' || new.id
      );
      return new;
    end;
    $$;
    create or replace trigger orders_start_fulfilment
      after insert on orders for each row execute function orders_start_fulfilment();
  `);
}
