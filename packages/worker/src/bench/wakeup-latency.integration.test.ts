import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { measureStartLatency } from "./wakeup-latency.ts";

describe("idle-queue start latency", () => {
  let database: IsolatedSchema;
  let notifying: Pool;
  let namespaceId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    notifying = createPool(process.env, { schema: database.schema, notifyWakeups: true });
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await notifying.end();
    await database.close();
  });

  it("reaches the first step well within one poll wait at the median with wake-ups on an idle engine", async () => {
    const summary = await measureStartLatency({
      enginePool: notifying,
      producerPool: notifying,
      namespaceId,
      queueName: "latency-notify",
      wakeups: true,
      samples: 20,
      pollIntervalMs: 500,
    });

    expect(summary.count).toBe(20);
    expect(summary.p50Ms).toBeLessThan(100);
  });

  it("waits for the poll backoff without wake-ups, which is what they remove", async () => {
    const summary = await measureStartLatency({
      enginePool: database.pool,
      producerPool: database.pool,
      namespaceId,
      queueName: "latency-poll",
      wakeups: false,
      samples: 8,
      pollIntervalMs: 500,
    });

    expect(summary.p50Ms).toBeGreaterThan(20);
  });
});
