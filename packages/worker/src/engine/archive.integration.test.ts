import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresEventStore,
  defineStep,
  defineWorkflow,
  readRunEventArchive,
  replayHistories,
  type Pool,
} from "@dee/core";
import { createRunService } from "../../../api/src/index.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { createShiftableClock } from "../chaos/world.ts";
import { startEngine } from "./runtime.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe("archival of a dropped partition", () => {
  let database: IsolatedSchema;
  let pool: Pool;
  let directory: string;

  const charge = defineStep<{ index: number }, number>("charge", {
    handler: ({ index }) => index * 10,
  });
  const order = defineWorkflow("order", async (ctx, input: { index: number }) => {
    const charged = await ctx.step<number>("charge", input);
    await ctx.sleep(1);
    return charged + 1;
  });
  const changedOrder = defineWorkflow("order", async (ctx, input: { index: number }) => {
    return ctx.step<number>("charge", { index: input.index + 1 });
  });

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    pool = database.pool;
    directory = await mkdtemp(path.join(tmpdir(), "dee-engine-archive-"));
  });

  afterAll(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function count(sql: string, values: unknown[] = []): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count);
  }

  it("archives the partition of purged runs, drops it, and the archive replays", async () => {
    const created = await pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    const namespaceId = created.rows[0]?.id ?? "";
    const clock = createShiftableClock();
    const errors: unknown[] = [];
    const engine = startEngine({
      pool,
      clock,
      workflows: [order],
      steps: [charge],
      pollIntervalMs: 5,
      loopIntervalMs: 20,
      stickyRouting: false,
      shutdownTimeoutMs: 2_000,
      retention: { closedRunRetentionMs: HOUR_MS, finishedTaskGraceMs: 0 },
      partitions: { intervalMs: 50, archiveDirectory: directory },
      onError: (error) => {
        errors.push(error);
      },
    });
    const archivedTo = path.join(directory, "run_events_legacy.ndjson");
    try {
      const service = createRunService(pool, { queueName: "default" });
      const runIds: string[] = [];
      for (let index = 1; index <= 5; index += 1) {
        const started = await service.startRun(namespaceId, {
          workflowType: "order",
          input: { index },
        });
        runIds.push(started.run.runId);
      }
      await waitUntil(
        async () =>
          (await count(
            "select count(*) from workflow_runs where id = any($1::uuid[]) and status = 'COMPLETED'",
            [runIds],
          )) === runIds.length,
        "the orders to complete",
      );
      const eventsBefore = await count("select count(*) from run_events");
      expect(await exists(archivedTo)).toBe(false);
      expect(
        await count("select count(*) from pg_class where oid = to_regclass('run_events_legacy')"),
      ).toBe(1);

      clock.shift(2 * DAY_MS + 2 * HOUR_MS);
      await waitUntil(() => exists(archivedTo), "the archive of the legacy partition");
      await waitUntil(
        async () =>
          (await count(
            "select count(*) from pg_class where oid = to_regclass('run_events_legacy')",
          )) === 0,
        "the legacy partition to be dropped",
      );

      const contents = readRunEventArchive(await readFile(archivedTo, "utf8"), archivedTo);
      expect(contents.histories.map((history) => history.runId).sort()).toEqual([...runIds].sort());
      expect(contents.histories.reduce((total, history) => total + history.events.length, 0)).toBe(
        eventsBefore,
      );
      expect(await createPostgresEventStore(pool).read(runIds[0] ?? "")).toEqual([]);
      const histories = contents.histories.map((history) => ({
        source: archivedTo,
        history: history,
      }));
      const replayed = await replayHistories([order], histories);
      expect(replayed.failed).toBe(0);
      expect(replayed.passed).toBe(runIds.length);
      const broken = await replayHistories([changedOrder], histories);
      expect(broken.failed).toBe(runIds.length);
      expect(broken.results[0]?.problem?.kind).toBe("non_determinism");
      const recorded = await pool.query<{ archived_to: string; archived_events: string }>(
        "select archived_to, archived_events from run_event_partitions where name = 'run_events_legacy'",
      );
      expect(recorded.rows[0]).toEqual({
        archived_to: archivedTo,
        archived_events: String(eventsBefore),
      });
    } finally {
      await engine.stop();
    }
    expect(errors).toEqual([]);
  });
});
