import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createPostgresEventStore } from "../event-store/event-store.ts";
import type { ClockSource } from "../workflow/sources.ts";
import { createPartitionMaintainer } from "./partition-maintainer.ts";
import {
  createDirectoryArchive,
  readRunEventArchive,
  type RunEventArchive,
} from "./run-event-archive.ts";

const DAY_MS = 24 * 3_600_000;
const JAN_10 = new Date("2030-01-10T00:00:00.000Z");

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

describe("run_events partitions", () => {
  let database: IsolatedSchema;
  let directory: string;
  let now: Date;
  let namespaceId: string;
  const clock: ClockSource = { now: () => now };

  beforeEach(async () => {
    database = await createIsolatedDatabase();
    directory = await mkdtemp(path.join(tmpdir(), "dee-archive-"));
    now = JAN_10;
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('partitions') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterEach(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function seedRun(createdAt: Date, steps: number, status = "COMPLETED"): Promise<string> {
    const run = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, status, created_at, started_at,
                                  closed_at)
       values ($1, 'archived', $2::text, $3::timestamptz, $3::timestamptz,
               case when $2::text = 'RUNNING' then null else $3::timestamptz end)
       returning id`,
      [namespaceId, status, createdAt],
    );
    const runId = run.rows[0]?.id ?? "";
    const store = createPostgresEventStore(database.pool);
    await store.append(runId, 0, [{ type: "run_started", workflowType: "archived", input: null }]);
    for (let step = 1; step <= steps; step += 1) {
      await store.append(runId, step, [
        { type: "step_scheduled", stepId: `s${String(step)}`, stepType: "work", input: step },
      ]);
    }
    return runId;
  }

  async function partitionOf(runId: string): Promise<string[]> {
    const result = await database.pool.query<{ partition: string }>(
      "select distinct tableoid::regclass::text as partition from run_events where run_id = $1",
      [runId],
    );
    return result.rows.map((row) => row.partition);
  }

  async function tableExists(name: string): Promise<boolean> {
    const result = await database.pool.query<{ found: string | null }>(
      "select to_regclass($1) as found",
      [name],
    );
    return result.rows[0]?.found !== null;
  }

  async function purge(runIds: readonly string[]): Promise<void> {
    await database.pool.query(
      "update workflow_runs set purged_at = $2 where id = any($1::uuid[])",
      [runIds, now],
    );
  }

  it("creates one partition per day ahead and only the missing ones on the next run", async () => {
    const maintainer = createPartitionMaintainer(database.pool, { clock, aheadDays: 3 });

    const first = await maintainer.runOnce();
    now = at(JAN_10, DAY_MS);
    const second = await maintainer.runOnce();

    expect(first.created).toEqual([
      "run_events_p20300110",
      "run_events_p20300111",
      "run_events_p20300112",
      "run_events_p20300113",
    ]);
    expect(second.created).toEqual(["run_events_p20300114"]);
    const partitions = await maintainer.listPartitions();
    expect(partitions.at(-1)).toMatchObject({
      name: "run_events_p20300114",
      lowerBound: new Date("2030-01-14T00:00:00.000Z"),
      upperBound: new Date("2030-01-15T00:00:00.000Z"),
    });
  });

  it("writes every event of a run into the partition of the day the run was created", async () => {
    await createPartitionMaintainer(database.pool, { clock, aheadDays: 2 }).runOnce();

    const runId = await seedRun(at(JAN_10, DAY_MS + 23 * 3_600_000), 3, "RUNNING");
    const store = createPostgresEventStore(database.pool);

    expect(await partitionOf(runId)).toEqual(["run_events_p20300111"]);
    expect((await store.read(runId)).map((stored) => stored.sequenceNumber)).toEqual([1, 2, 3, 4]);
  });

  it("moves rows out of the default partition when their day's partition is created", async () => {
    const runId = await seedRun(at(JAN_10, 40 * DAY_MS), 2);
    expect(await partitionOf(runId)).toEqual(["run_events_default"]);

    now = at(JAN_10, 40 * DAY_MS);
    const report = await createPartitionMaintainer(database.pool, {
      clock,
      aheadDays: 0,
    }).runOnce();

    expect(report.created).toEqual(["run_events_p20300219"]);
    expect(await partitionOf(runId)).toEqual(["run_events_p20300219"]);
    const left = await database.pool.query<{ count: string }>(
      "select count(*) from run_events_default",
    );
    expect(left.rows[0]?.count).toBe("0");
  });

  it("keeps a partition while one of its runs is not purged, then archives and drops it", async () => {
    const maintainer = createPartitionMaintainer(database.pool, {
      clock,
      aheadDays: 2,
      archive: createDirectoryArchive(directory),
    });
    await maintainer.runOnce();
    const closed = await seedRun(at(JAN_10, 3_600_000), 2);
    const lingering = await seedRun(at(JAN_10, 7_200_000), 1);
    const open = await seedRun(at(JAN_10, DAY_MS + 3_600_000), 1, "RUNNING");
    await purge([closed]);
    now = at(JAN_10, 3 * DAY_MS);

    const whileLingering = await maintainer.runOnce();
    expect(whileLingering.dropped.map((dropped) => dropped.name)).not.toContain(
      "run_events_p20300110",
    );
    expect(await tableExists("run_events_p20300110")).toBe(true);

    await purge([lingering]);
    const report = await maintainer.runOnce();

    const archivedTo = path.join(directory, "run_events_p20300110.ndjson");
    expect(report.dropped).toEqual([{ name: "run_events_p20300110", events: 5, archivedTo }]);
    expect(await tableExists("run_events_p20300110")).toBe(false);
    expect(await readdir(directory)).toContain("run_events_p20300110.ndjson");
    const contents = readRunEventArchive(await readFile(archivedTo, "utf8"), archivedTo);
    expect(contents.partition).toBe("run_events_p20300110");
    expect(contents.histories.map((history) => history.runId).sort()).toEqual(
      [closed, lingering].sort(),
    );
    expect(contents.unreadable).toEqual([]);
    expect(await partitionOf(open)).toEqual(["run_events_p20300111"]);
    const remaining = await maintainer.listPartitions();
    expect(remaining.find((partition) => partition.name === "run_events_p20300110")).toMatchObject({
      archivedTo,
      droppedAt: now,
    });
  });

  it("keeps a partition when its archive fails", async () => {
    const failing: RunEventArchive = {
      write() {
        return Promise.reject(new Error("disk full"));
      },
    };
    const maintainer = createPartitionMaintainer(database.pool, {
      clock,
      aheadDays: 0,
      archive: failing,
    });
    await maintainer.runOnce();
    const runId = await seedRun(at(JAN_10, 3_600_000), 1);
    await purge([runId]);
    now = at(JAN_10, 2 * DAY_MS);

    const report = await maintainer.runOnce();

    expect(report.dropped).toEqual([]);
    expect(report.kept).toContainEqual({
      name: "run_events_p20300110",
      reason: "the archive failed: disk full",
    });
    expect(await partitionOf(runId)).toEqual(["run_events_p20300110"]);
  });

  it("keeps a partition that received an event while it was being archived", async () => {
    const runId = await seedRun(at(JAN_10, 3_600_000), 0);
    const racing: RunEventArchive = {
      async write(_partition, lines) {
        for await (const line of lines) {
          expect(line.length).toBeGreaterThan(0);
        }
        await createPostgresEventStore(database.pool).append(runId, 1, [
          { type: "cancel_requested", reason: "late" },
        ]);
        return "memory";
      },
    };
    const maintainer = createPartitionMaintainer(database.pool, {
      clock,
      aheadDays: 0,
      archive: racing,
    });
    await createPartitionMaintainer(database.pool, { clock, aheadDays: 0 }).runOnce();
    await database.pool.query(`update workflow_runs set purged_at = $2 where id = $1`, [
      runId,
      at(JAN_10, DAY_MS),
    ]);
    expect(await partitionOf(runId)).toEqual(["run_events_p20300110"]);
    now = at(JAN_10, 2 * DAY_MS);

    const report = await maintainer.runOnce();

    expect(report.dropped).toEqual([]);
    expect(report.kept.map((kept) => kept.reason)).toContain("it held 2 events after archiving 1");
    expect(await createPostgresEventStore(database.pool).read(runId)).toHaveLength(2);
  });
});
