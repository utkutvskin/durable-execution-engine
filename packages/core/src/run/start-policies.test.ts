import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "../db/env.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { withTransaction } from "../db/transaction.ts";
import { jsonCodec } from "../event-store/codec.ts";
import { insertRunOnClient } from "./insert-run.ts";
import {
  InvalidStartPolicyError,
  SingletonRunOpenError,
  admitStartOnClient,
  createPendingStartFirer,
  liveIdempotencyKeyCondition,
  readPendingStart,
  validateStartPolicies,
  type PendingStart,
  type StartPolicies,
} from "./start-policies.ts";

function movableClock(): { now(): Date; advance(ms: number): void } {
  let elapsed = 0;
  const start = new Date("2026-03-01T12:00:00.000Z").getTime();
  return {
    now: () => new Date(start + elapsed),
    advance(ms: number): void {
      elapsed += ms;
    },
  };
}

type Outcome =
  | { readonly kind: "created"; readonly runId: string }
  | { readonly kind: "existing"; readonly runId: string }
  | { readonly kind: "pending"; readonly pending: PendingStart };

describe("start policies", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  const extraPools: pg.Pool[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const result = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('policies') returning id",
    );
    namespaceId = result.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await Promise.all(extraPools.map((pool) => pool.end()));
    await database.close();
  });

  async function start(
    pool: pg.Pool,
    now: Date,
    input: unknown,
    policies: StartPolicies,
    workflowType = "order",
  ): Promise<Outcome> {
    validateStartPolicies(policies);
    if (policies.idempotencyKey !== undefined) {
      const earlier = await pool.query<{ id: string }>(
        `select id from workflow_runs where namespace_id = $1 and idempotency_key = $2
         and ${liveIdempotencyKeyCondition(3)}`,
        [namespaceId, policies.idempotencyKey, now],
      );
      const id = earlier.rows[0]?.id;
      if (id !== undefined) {
        return { kind: "existing", runId: id };
      }
    }
    return withTransaction(pool, async (client) => {
      const request = { namespaceId, workflowType, input, queueName: "default", options: {} };
      const admission = await admitStartOnClient(client, request, policies, now);
      if (admission.kind === "pending") {
        return { kind: "pending", pending: admission.pending };
      }
      const runId = await insertRunOnClient(client, jsonCodec, {
        ...request,
        idempotencyKey: policies.idempotencyKey,
        idempotencyExpiresAt:
          policies.idempotencyTtlMs === undefined
            ? undefined
            : new Date(now.getTime() + policies.idempotencyTtlMs),
        singletonKey: admission.singletonKey,
      });
      if (runId === undefined) {
        throw new Error("the idempotency key raced");
      }
      return { kind: "created", runId };
    });
  }

  async function runsOf(workflowType: string): Promise<{ id: string; input: unknown }[]> {
    const result = await database.pool.query<{ id: string; input: unknown }>(
      "select id, input from workflow_runs where workflow_type = $1 order by started_at, id",
      [workflowType],
    );
    return result.rows;
  }

  async function close(runId: string): Promise<void> {
    await database.pool.query(
      "update workflow_runs set status = 'COMPLETED', closed_at = now() where id = $1",
      [runId],
    );
  }

  it("turns 10 starts in one debounce window into one run with the last input", async () => {
    const clock = movableClock();
    const firer = createPendingStartFirer(database.pool, { clock });
    const debounce = { key: "customer-1", windowMs: 5000 };
    const outcomes: Outcome[] = [];
    for (let index = 1; index <= 10; index += 1) {
      outcomes.push(await start(database.pool, clock.now(), { n: index }, { debounce }, "deb"));
      clock.advance(400);
    }
    const runIds = new Set(
      outcomes.map((outcome) => (outcome.kind === "pending" ? outcome.pending.runId : "")),
    );
    expect(runIds.size).toBe(1);
    expect(await firer.fireDue()).toEqual({ debounced: [], singletons: [] });
    expect(await runsOf("deb")).toEqual([]);
    clock.advance(1000);
    const [runId] = [...runIds];
    expect(await firer.fireDue()).toEqual({ debounced: [runId], singletons: [] });
    expect(await runsOf("deb")).toEqual([{ id: runId, input: { n: 10 } }]);
    expect(await firer.fireDue()).toEqual({ debounced: [], singletons: [] });
    const events = await database.pool.query<{ payload: { input: unknown } }>(
      "select payload from run_events where run_id = $1 order by sequence_number",
      [runId],
    );
    expect(events.rows[0]?.payload.input).toEqual({ n: 10 });
    const last = outcomes.at(-1);
    expect(last?.kind === "pending" ? last.pending.startCount : 0).toBe(10);
  });

  it("opens a new debounce window after the last one fired, and fires a due window on the next start", async () => {
    const clock = movableClock();
    const firer = createPendingStartFirer(database.pool, { clock });
    const debounce = { key: "customer-2", windowMs: 1000 };
    const first = await start(database.pool, clock.now(), { n: 1 }, { debounce }, "deb2");
    clock.advance(1500);
    const second = await start(database.pool, clock.now(), { n: 2 }, { debounce }, "deb2");
    expect(first.kind === "pending" && second.kind === "pending").toBe(true);
    const firstId = first.kind === "pending" ? first.pending.runId : "";
    const secondId = second.kind === "pending" ? second.pending.runId : "";
    expect(secondId).not.toBe(firstId);
    expect(await runsOf("deb2")).toEqual([{ id: firstId, input: { n: 1 } }]);
    expect(await readPendingStart(database.pool, namespaceId, secondId)).toMatchObject({
      kind: "debounce",
      startCount: 1,
    });
    clock.advance(1000);
    await firer.fireDue();
    expect((await runsOf("deb2")).map((run) => run.input)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await readPendingStart(database.pool, namespaceId, secondId)).toBeUndefined();
  });

  it("lets exactly one of 20 concurrent singleton starts open a run", async () => {
    const pools = Array.from(
      { length: 4 },
      () =>
        new pg.Pool({
          connectionString: resolveDatabaseUrl(process.env),
          options: `-c search_path=${database.schema}`,
          max: 5,
        }),
    );
    extraPools.push(...pools);
    const now = new Date();
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        start(
          pools[index % pools.length] ?? database.pool,
          now,
          { n: index },
          { singleton: { key: "nightly" } },
          "single",
        ),
      ),
    );
    const created = settled.filter((entry) => entry.status === "fulfilled");
    const refused = settled.filter(
      (entry) => entry.status === "rejected" && entry.reason instanceof SingletonRunOpenError,
    );
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(19);
    const open = await database.pool.query<{ count: string }>(
      "select count(*) from workflow_runs where singleton_key = 'nightly' and status = 'RUNNING'",
    );
    expect(Number(open.rows[0]?.count)).toBe(1);
  });

  it("queues singleton starts while a run is open and starts them one at a time in order", async () => {
    const clock = movableClock();
    const firer = createPendingStartFirer(database.pool, { clock });
    const singleton = { key: "report", whenOpen: "queue" as const };
    const first = await start(database.pool, clock.now(), { n: 1 }, { singleton }, "queued");
    const second = await start(database.pool, clock.now(), { n: 2 }, { singleton }, "queued");
    const third = await start(database.pool, clock.now(), { n: 3 }, { singleton }, "queued");
    expect([first.kind, second.kind, third.kind]).toEqual(["created", "pending", "pending"]);
    await expect(
      start(database.pool, clock.now(), { n: 4 }, { singleton: { key: "report" } }, "queued"),
    ).rejects.toBeInstanceOf(SingletonRunOpenError);
    expect(await firer.fireDue()).toEqual({ debounced: [], singletons: [] });
    await close(first.kind === "created" ? first.runId : "");
    const fired = await firer.fireDue();
    const secondId = second.kind === "pending" ? second.pending.runId : "";
    expect(fired.singletons).toEqual([secondId]);
    expect(await firer.fireDue()).toEqual({ debounced: [], singletons: [] });
    await close(secondId);
    await firer.fireDue();
    expect((await runsOf("queued")).map((run) => run.input)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
    const lastOpen = await database.pool.query<{ singleton_key: string }>(
      "select singleton_key from workflow_runs where workflow_type = 'queued' and status = 'RUNNING'",
    );
    expect(lastOpen.rows).toEqual([{ singleton_key: "report" }]);
  });

  it("starts a new run once an idempotency key's TTL has expired, and returns the old run before", async () => {
    const clock = movableClock();
    const policies = { idempotencyKey: "pay-1", idempotencyTtlMs: 60_000 };
    const first = await start(database.pool, clock.now(), { n: 1 }, policies, "ttl");
    clock.advance(59_999);
    const repeated = await start(database.pool, clock.now(), { n: 1 }, policies, "ttl");
    clock.advance(1);
    const renewed = await start(database.pool, clock.now(), { n: 1 }, policies, "ttl");
    expect(first.kind).toBe("created");
    expect(repeated).toEqual({
      kind: "existing",
      runId: first.kind === "created" ? first.runId : "",
    });
    expect(renewed.kind).toBe("created");
    const keys = await database.pool.query<{ id: string; idempotency_key: string | null }>(
      "select id, idempotency_key from workflow_runs where workflow_type = 'ttl' order by started_at, id",
    );
    expect(keys.rows.map((row) => row.idempotency_key).sort()).toEqual(["pay-1", null].sort());
    expect(keys.rows.find((row) => row.idempotency_key === "pay-1")?.id).toBe(
      renewed.kind === "created" ? renewed.runId : "",
    );
  });

  it("refuses malformed and unsupported combinations of policies", () => {
    const invalid: StartPolicies[] = [
      { idempotencyTtlMs: 1000 },
      { idempotencyKey: "k", idempotencyTtlMs: 0 },
      { debounce: { key: "", windowMs: 10 } },
      { debounce: { key: "k", windowMs: 1.5 } },
      { debounce: { key: "k", windowMs: 10 }, singleton: { key: "k" } },
      { debounce: { key: "k", windowMs: 10 }, idempotencyKey: "k" },
      { singleton: { key: "k", whenOpen: "queue" }, idempotencyKey: "k" },
      { singleton: { key: "x".repeat(257) } },
    ];
    for (const policies of invalid) {
      expect(() => {
        validateStartPolicies(policies);
      }).toThrow(InvalidStartPolicyError);
    }
    expect(() => {
      validateStartPolicies({ singleton: { key: "k" }, idempotencyKey: "k", idempotencyTtlMs: 5 });
    }).not.toThrow();
  });
});
