import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createInvariantChecker,
  createPostgresEventStore,
  createRunReset,
  defineStep,
  defineWorkflow,
  InvalidResetPointError,
  NonRetryableError,
  type Pool,
  type RunReset,
} from "@dee/core";
import { createRunService, type RunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createShiftableClock, type ShiftableClock } from "../chaos/world.ts";
import { startEngine, type Engine, type EngineOptions } from "./runtime.ts";

interface Order {
  readonly orderId: string;
}

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("reset and fork in the engine", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let service: RunService;
  let reset: RunReset;
  let clock: ShiftableClock;
  let namespaceId: string;
  const engines: Engine[] = [];
  const errors: unknown[] = [];
  const calls: string[] = [];
  let chargeIsBroken = true;

  const reserve = defineStep<Order, string>("reserve", {
    handler: (order) => {
      calls.push(`reserve ${order.orderId}`);
      return Promise.resolve(`reserved ${order.orderId}`);
    },
  });
  const charge = defineStep<Order, string>("charge", {
    handler: (order) => {
      calls.push(`charge ${order.orderId}`);
      if (chargeIsBroken) {
        return Promise.reject(new NonRetryableError("charge has a bug"));
      }
      return Promise.resolve(`charged ${order.orderId}`);
    },
  });
  const ship = defineStep<Order, string>("ship", {
    handler: (order) => {
      calls.push(`ship ${order.orderId}`);
      return Promise.resolve(`shipped ${order.orderId}`);
    },
  });
  const order = defineWorkflow<Order, string[]>("order", async (ctx, input) => [
    await ctx.step(reserve, input),
    await ctx.step(charge, input),
    await ctx.step(ship, input),
  ]);
  const orderV2 = defineWorkflow<Order, string[]>("order-v2", async (ctx, input) => [
    await ctx.step(reserve, input),
    await ctx.step(charge, input),
    `gift wrapped ${input.orderId}`,
  ]);
  const approval = defineWorkflow<Order, string>("approval", async (ctx, input) => {
    await ctx.step(reserve, input);
    const decision = await ctx.waitForSignal<string>("decision");
    return `${decision} ${input.orderId}`;
  });
  const napping = defineWorkflow<Order, string>("napping", async (ctx, input) => {
    await ctx.step(reserve, input);
    await ctx.sleep(60_000);
    return "awake";
  });

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
    service = createRunService(pool, { queueName: "default" });
    reset = createRunReset(pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await pool.query("truncate namespaces cascade");
    await pool.query("truncate run_events");
    const created = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = created.rows[0]?.id ?? "";
    clock = createShiftableClock();
    errors.length = 0;
    calls.length = 0;
    chargeIsBroken = true;
  });

  afterEach(async () => {
    for (const engine of engines.splice(0)) {
      await engine.stop();
    }
  });

  function boot(options: Partial<Omit<EngineOptions, "pool" | "onError" | "clock">> = {}): Engine {
    const engine = startEngine({
      pool,
      clock,
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      stickyRouting: false,
      workflows: [order, orderV2, approval, napping],
      steps: [reserve, charge, ship],
      ...options,
      onError: (error) => {
        errors.push(error);
      },
    });
    engines.push(engine);
    return engine;
  }

  async function start(workflowType: string, input: unknown): Promise<string> {
    const started = await service.startRun(namespaceId, { workflowType, input });
    return started.run.runId;
  }

  async function status(runId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      "select status from workflow_runs where id = $1",
      [runId],
    );
    return result.rows[0]?.status ?? "missing";
  }

  async function eventTypes(runId: string): Promise<string[]> {
    const events = await createPostgresEventStore(pool).read(runId);
    return events.map((stored) => stored.event.type);
  }

  async function result(runId: string): Promise<unknown> {
    const events = await createPostgresEventStore(pool).read(runId);
    const closing = events.at(-1)?.event;
    return closing?.type === "run_completed" ? closing.result : undefined;
  }

  it("resets a run that failed on a bug after the fix, without running the steps before the cut again", async () => {
    const broken = boot();
    const failed = await start("order", { orderId: "o-1" });
    await waitUntil(async () => (await status(failed)) === "FAILED", "the run to fail");
    await broken.stop();
    engines.splice(engines.indexOf(broken), 1);
    expect(calls).toEqual(["reserve o-1", "charge o-1"]);

    chargeIsBroken = false;
    boot();
    const receipt = await reset.resetRun({ runId: failed, point: { kind: "failed-step" } });
    await waitUntil(async () => (await status(receipt.runId)) === "COMPLETED", "the reset run");

    expect(calls).toEqual(["reserve o-1", "charge o-1", "charge o-1", "ship o-1"]);
    expect(await result(receipt.runId)).toEqual(["reserved o-1", "charged o-1", "shipped o-1"]);
    expect(receipt).toMatchObject({
      resetFromRunId: failed,
      kind: "reset",
      workflowType: "order",
      eventSequence: 3,
      terminatedOriginal: false,
      rescheduledSteps: [],
    });
    expect(await status(failed)).toBe("FAILED");
    expect((await eventTypes(receipt.runId)).slice(0, 3)).toEqual([
      "run_started",
      "step_scheduled",
      "step_completed",
    ]);
    const link = await pool.query(
      "select reset_from_run_id, reset_event_sequence, reset_kind from workflow_runs where id = $1",
      [receipt.runId],
    );
    expect(link.rows).toEqual([
      { reset_from_run_id: failed, reset_event_sequence: 3, reset_kind: "reset" },
    ]);
    const checker = createInvariantChecker(pool, createPostgresEventStore(pool));
    expect((await checker.check({ runIds: [failed, receipt.runId] })).violations).toEqual([]);
  });

  it("forks a completed run onto new code from step 2 and leaves the original as it was", async () => {
    chargeIsBroken = false;
    boot();
    const original = await start("order", { orderId: "o-2" });
    await waitUntil(async () => (await status(original)) === "COMPLETED", "the original run");
    const originalEvents = await eventTypes(original);

    const receipt = await reset.forkRun({
      runId: original,
      point: { kind: "step", step: 2 },
      workflowType: "order-v2",
    });
    await waitUntil(async () => (await status(receipt.runId)) === "COMPLETED", "the fork");

    expect(calls).toEqual(["reserve o-2", "charge o-2", "ship o-2", "charge o-2"]);
    expect(await result(receipt.runId)).toEqual([
      "reserved o-2",
      "charged o-2",
      "gift wrapped o-2",
    ]);
    expect(receipt).toMatchObject({ kind: "fork", workflowType: "order-v2", eventSequence: 3 });
    expect(await eventTypes(original)).toEqual(originalEvents);
    expect(await status(original)).toBe("COMPLETED");
  });

  it("terminates an open run it resets, and the new run goes on waiting for its signal", async () => {
    boot();
    const waiting = await start("approval", { orderId: "o-3" });
    await waitUntil(
      async () => (await eventTypes(waiting)).includes("step_completed"),
      "the reservation",
    );

    const receipt = await reset.resetRun({
      runId: waiting,
      point: { kind: "event", sequence: 3 },
      reason: "operator reset",
    });
    expect(receipt.terminatedOriginal).toBe(true);
    expect(await status(waiting)).toBe("TERMINATED");
    expect((await eventTypes(waiting)).at(-1)).toBe("run_terminated");
    await service.signalRun(namespaceId, receipt.runId, "decision", "approved");
    await waitUntil(async () => (await status(receipt.runId)) === "COMPLETED", "the new run");

    expect(await result(receipt.runId)).toBe("approved o-3");
    expect(calls).toEqual(["reserve o-3"]);
  });

  it("executes a step whose step_scheduled event the cut kept without its result", async () => {
    chargeIsBroken = false;
    boot();
    const original = await start("order", { orderId: "o-4" });
    await waitUntil(async () => (await status(original)) === "COMPLETED", "the original run");

    const receipt = await reset.forkRun({ runId: original, point: { kind: "event", sequence: 4 } });
    await waitUntil(async () => (await status(receipt.runId)) === "COMPLETED", "the fork");

    expect(receipt.rescheduledSteps).toHaveLength(1);
    expect(calls.slice(3)).toEqual(["charge o-4", "ship o-4"]);
  });

  it("refuses a cut that leaves a timer running, keeps a closing event, or names no event", async () => {
    boot();
    const sleeping = await start("napping", { orderId: "o-5" });
    await waitUntil(
      async () => (await eventTypes(sleeping)).includes("timer_started"),
      "the timer",
    );
    const types = await eventTypes(sleeping);

    await expect(
      reset.forkRun({ runId: sleeping, point: { kind: "event", sequence: types.length } }),
    ).rejects.toThrow(/timer "timer-1" has not fired/);
    await expect(
      reset.forkRun({ runId: sleeping, point: { kind: "event", sequence: 99 } }),
    ).rejects.toBeInstanceOf(InvalidResetPointError);
    await expect(
      reset.forkRun({ runId: sleeping, point: { kind: "failed-step" } }),
    ).rejects.toThrow(/no step of the run failed/);
    clock.shift(60_001);
    await waitUntil(async () => (await status(sleeping)) === "COMPLETED", "the nap");
    await expect(
      reset.forkRun({ runId: sleeping, point: { kind: "event", sequence: 99 } }),
    ).rejects.toThrow(/is not between 1 and/);
    const all = await eventTypes(sleeping);
    await expect(
      reset.forkRun({ runId: sleeping, point: { kind: "event", sequence: all.length } }),
    ).rejects.toThrow(/already holds run_completed/);
    const points = await reset.listResetPoints(sleeping);
    expect(points.map((point) => point.eventType)).not.toContain("timer_started");
    expect(points.at(-1)?.sequence).toBe(all.length - 1);
  });
});
