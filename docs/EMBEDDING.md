# Embedding the engine

The engine keeps its state in Postgres, so it can share a database, and a transaction, with your application. This page shows how to start, signal and cancel a workflow atomically with your own writes, how to enqueue from SQL, and how to keep the engine tables in a schema of their own.

The complete example is `examples/outbox/`: an order insert and the start of its fulfilment in one transaction.

## Why a transactional start

The usual way to trigger background work from a request is to write a row and then call a queue. Between the two, the process can crash, or the commit can fail after the call: the order exists without its fulfilment, or the fulfilment runs for an order that was rolled back. An outbox table fixes this with a second process that reads the table and calls the queue.

With the engine in the same database the run itself is the outbox. `startWorkflow` writes the run row, its `run_started` event, its timeout timers and its first workflow task in your transaction. If you commit, a worker sees the task and runs the workflow. If you roll back, none of it ever existed. No worker can pick the task up before the commit, because it is not visible until then.

## Setting up the schema

Put the engine tables in a schema of their own, next to your application's, so their names (`workflow_runs`, `tasks`, `namespaces`, ...) never meet yours:

```ts
import { createPool, defaultMigrationsDir, migrateUp } from "@dee/core";

const appPool = createPool(process.env);
await migrateUp(appPool, defaultMigrationsDir, { schema: "dee" });
```

`migrateUp` with `schema` creates the schema when it does not exist, applies the migrations there (with their own `schema_migrations` table) and puts the connection's `search_path` back when it is done, so the pool you pass keeps resolving your own tables. `migrateDown` and `pendingMigrations` take the same option.

The engine itself reads and writes its tables through a pool whose connections default to that schema:

```ts
import { createPool } from "@dee/core";
import { startEngine } from "@dee/worker";

const enginePool = createPool(process.env, { schema: "dee" });
const engine = startEngine({ pool: enginePool, workflows, steps });
```

Without `schema` everything resolves through the connection's `search_path`, which is `public` by default; that is how a database set up with `wf migrate up` works and it still does.

## Starting, signalling and cancelling in your transaction

The three functions take a client that has an open transaction and never commit or roll back on their own:

```ts
import { startWorkflow } from "@dee/core";

const client = await appPool.connect();
try {
  await client.query("begin");
  await client.query("insert into orders (id, customer) values ($1, $2)", [
    order.id,
    order.customer,
  ]);
  const { runId } = await startWorkflow(client, {
    workflowType: "outbox.fulfil-order",
    input: { orderId: order.id },
    idempotencyKey: `order:${order.id}`,
    schema: "dee",
  });
  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
}
```

- `startWorkflow(client, input)` takes `workflowType`, `input`, `idempotencyKey`, `namespace` (a name, default `default`, created when missing), `queueName` (default `default`), `runTimeoutMs` and `executionTimeoutMs`. It returns `{ runId, created }`; `created` is false when the idempotency key had already started a run with the same type and input. The same key with a different type or input rejects with `IdempotencyKeyConflictError`.
- `signalWorkflow(client, { runId, signalName, payload })` records `signal_received` and the task that delivers it. It rejects with `RunNotFoundError` or `RunNotOpenError`.
- `cancelWorkflow(client, { runId, reason })` records `cancel_requested` and its task, or writes nothing when a request is already pending. It rejects with `RunNotFoundError` or `RunAlreadyClosedError`.

All three accept `schema` and `codec`. `codec` must be the one the engine reads history with; the default is the plain JSON codec.

Each call runs inside a savepoint. A call that rejects rolls back to its savepoint, so your transaction is still usable and holds none of the engine's writes; you decide whether to commit the rest. A client without an open transaction is refused with `NoOpenTransactionError` before anything is written. `schema` is used only for the engine's own statements: the `search_path` of your transaction is the same after the call as before it.

`signalWorkflow` and `cancelWorkflow` lock the run row until your transaction ends, as the API does for the length of its own short transaction. Keep the transaction short, or a worker deciding that run waits for it.

## Enqueueing from SQL

The migrations install a function in the engine schema:

```sql
dee.start_workflow(
  workflow_type text,
  input jsonb default 'null',
  idempotency_key text default null,
  namespace text default 'default',
  queue_name text default 'default'
) returns uuid
```

It writes the same rows as `startWorkflow`, in the calling transaction, and returns the run id. A repeated idempotency key returns the first run, a different request under the same key raises an error. The function keeps the `search_path` it was created with, so it finds the engine tables wherever it is called from. That makes it usable from a trigger, a stored procedure, `psql` or a service in any language:

```sql
create function orders_start_fulfilment() returns trigger language plpgsql as $$
begin
  perform dee.start_workflow(
    'outbox.fulfil-order',
    jsonb_build_object('orderId', new.id),
    idempotency_key => 'order:' || new.id
  );
  return new;
end;
$$;

create trigger orders_start_fulfilment
  after insert on orders for each row execute function orders_start_fulfilment();
```

The function does not set run timeouts and always writes plain JSON; a deployment with a compressing codec starts runs from Node instead.

## The example

`examples/outbox/src/index.ts` has the workflow, `createOrderTables`, `placeOrder` and `installOrderTrigger`. Its test, `outbox.integration.test.ts`, migrates the engine into a schema next to the application's, then checks that:

- a committed order's run completes on an engine whose pool points at that schema;
- an order whose last line breaks a check constraint leaves no order, run, event or task;
- placing the same order twice keeps one order and one run;
- an insert through the trigger starts a run that completes, and the trigger and `placeOrder` together start one run, because both use the key `order:<id>`.

Run it with `pnpm exec vitest run examples/outbox`.
