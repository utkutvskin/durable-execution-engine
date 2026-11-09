import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedDatabase, type IsolatedSchema } from "../db/test-harness.ts";
import { createJanitor, MAX_RECOVERY_BACKOFF_MS } from "./janitor.ts";
import { markRunWaiting } from "./run-waiting.ts";

const START = new Date("2026-04-01T00:00:00.000Z");
const GRACE_MS = 30_000;

function movableClock(): { now(): Date; advance(ms: number): void } {
  let elapsed = 0;
  return {
    now: () => new Date(START.getTime() + elapsed),
    advance(ms: number): void {
      elapsed += ms;
    },
  };
}

describe("janitor and waiting runs", () => {
  let database: IsolatedSchema;
  let namespaceId: string;
  let clock: ReturnType<typeof movableClock>;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    const namespace = await database.pool.query<{ id: string }>(
      "insert into namespaces (name) values ('default') returning id",
    );
    namespaceId = namespace.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query("delete from tasks");
    await database.pool.query("delete from run_events");
    await database.pool.query("delete from workflow_runs");
    clock = movableClock();
  });

  async function createRun(): Promise<string> {
    const result = await database.pool.query<{ id: string }>(
      `insert into workflow_runs (namespace_id, workflow_type, status, created_at, queue_name)
       values ($1, 'ship-order', 'RUNNING', $2, 'q') returning id`,
      [namespaceId, START],
    );
    return result.rows[0]?.id ?? "";
  }

  async function taskCount(runId: string): Promise<number> {
    const result = await database.pool.query<{ count: string }>(
      "select count(*) from tasks where run_id = $1",
      [runId],
    );
    return Number(result.rows[0]?.count);
  }

  async function sweepEvery(stepMs: number, totalMs: number, runId: string): Promise<number[]> {
    const janitor = createJanitor(database.pool, { clock });
    const counts: number[] = [];
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
      clock.advance(stepMs);
      await janitor.sweep({ queueName: "q", graceMs: GRACE_MS });
      await database.pool.query(
        "update tasks set state = 'COMPLETED' where run_id = $1 and state = 'PENDING'",
        [runId],
      );
      counts.push(await taskCount(runId));
    }
    return counts;
  }

  it("enqueues no workflow task in ten simulated minutes for a run waiting on a signal", async () => {
    const runId = await createRun();
    await markRunWaiting(database.pool, { runId, waitingOn: "external", progressed: true });
    const counts = await sweepEvery(1000, 600_000, runId);
    expect(counts.at(-1)).toBe(0);
  });

  it("does not report a run waiting on a dead-lettered step as stalled", async () => {
    const runId = await createRun();
    await markRunWaiting(database.pool, { runId, waitingOn: "dead_letter", progressed: true });
    clock.advance(GRACE_MS * 10);
    const janitor = createJanitor(database.pool, { clock });
    expect(await janitor.findStalledRuns({ graceMs: GRACE_MS, queueName: "q" })).toEqual([]);
  });

  it("still recovers a stalled run that is not marked as waiting", async () => {
    const runId = await createRun();
    clock.advance(GRACE_MS + 1);
    const janitor = createJanitor(database.pool, { clock });
    const recovered = await janitor.recoverStalledRuns({ queueName: "q", graceMs: GRACE_MS });
    expect(recovered.map((run) => run.runId)).toEqual([runId]);
    expect(await taskCount(runId)).toBe(1);
  });

  it("recovers a run again once the marker is cleared", async () => {
    const runId = await createRun();
    await markRunWaiting(database.pool, { runId, waitingOn: "external", progressed: true });
    clock.advance(GRACE_MS + 1);
    const janitor = createJanitor(database.pool, { clock });
    expect(await janitor.findStalledRuns({ graceMs: GRACE_MS, queueName: "q" })).toEqual([]);
    await markRunWaiting(database.pool, { runId, waitingOn: null, progressed: false });
    expect(
      (await janitor.findStalledRuns({ graceMs: GRACE_MS, queueName: "q" })).map(
        (run) => run.runId,
      ),
    ).toEqual([runId]);
  });

  it("backs off between repeated recoveries of the same run", async () => {
    await createRun();
    clock.advance(GRACE_MS + 1);
    const janitor = createJanitor(database.pool, { clock });
    const options = { queueName: "q", graceMs: GRACE_MS };
    expect(await janitor.recoverStalledRuns(options)).toHaveLength(1);
    await database.pool.query("update tasks set state = 'COMPLETED'");
    clock.advance(GRACE_MS * 2 - 1);
    expect(await janitor.recoverStalledRuns(options)).toHaveLength(0);
    clock.advance(1);
    expect(await janitor.recoverStalledRuns(options)).toHaveLength(1);
    await database.pool.query("update tasks set state = 'COMPLETED'");
    clock.advance(GRACE_MS * 4 - 1);
    expect(await janitor.recoverStalledRuns(options)).toHaveLength(0);
    clock.advance(1);
    expect(await janitor.recoverStalledRuns(options)).toHaveLength(1);
  });

  it("resets the backoff when a decision records progress", async () => {
    const runId = await createRun();
    clock.advance(GRACE_MS + 1);
    const janitor = createJanitor(database.pool, { clock });
    const options = { queueName: "q", graceMs: GRACE_MS };
    await janitor.recoverStalledRuns(options);
    await markRunWaiting(database.pool, { runId, waitingOn: null, progressed: true });
    await database.pool.query("update tasks set state = 'COMPLETED'");
    clock.advance(GRACE_MS * 2 + 1);
    expect(await janitor.recoverStalledRuns(options)).toHaveLength(1);
  });

  it("caps the backoff at the maximum", async () => {
    const runId = await createRun();
    await database.pool.query(
      "update workflow_runs set recovery_count = 40, last_recovered_at = $2 where id = $1",
      [runId, START],
    );
    clock.advance(MAX_RECOVERY_BACKOFF_MS + 1);
    const janitor = createJanitor(database.pool, { clock });
    expect(await janitor.findStalledRuns({ graceMs: GRACE_MS, queueName: "q" })).toHaveLength(1);
  });
});
