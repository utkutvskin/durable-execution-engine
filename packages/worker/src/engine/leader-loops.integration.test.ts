import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCountingPool, type CountingPool } from "../../../core/src/db/statement-counter.ts";
import { createIsolatedDatabase, type IsolatedSchema } from "../../../core/src/db/test-harness.ts";
import { waitFor } from "../test-support.ts";
import { startEngine, type Engine } from "./runtime.ts";

const LOOP_STATEMENTS = [
  /from timers join workflow_runs/,
  /^with expired as/,
  /^select \* from schedules/,
];

function loopStatements(counting: CountingPool): string[] {
  return counting.statements.filter((sql) => LOOP_STATEMENTS.some((pattern) => pattern.test(sql)));
}

describe("background loops on the elected engine", () => {
  let database: IsolatedSchema;
  const engines: { engine: Engine; counting: CountingPool }[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
  });

  afterEach(async () => {
    await Promise.all(engines.map(({ engine }) => engine.stop()));
    engines.length = 0;
  });

  afterAll(async () => {
    await database.close();
  });

  function boot(options: { readonly leaderElection?: boolean } = {}) {
    const counting = createCountingPool(database.pool);
    const engine = startEngine({
      pool: counting.pool,
      queueName: "elected",
      workflows: [],
      steps: [],
      loopIntervalMs: 10,
      leaderLeaseMs: 20,
      ...options,
    });
    const entry = { engine, counting };
    engines.push(entry);
    return entry;
  }

  async function passesOnLeader(entry: { counting: CountingPool }, passes: number) {
    await waitFor(
      () =>
        loopStatements(entry.counting).filter((sql) => sql.includes("from timers")).length >=
        passes,
    );
  }

  it("runs the timer, schedule and janitor loops on exactly one of three engines", async () => {
    const group = [boot(), boot(), boot()];
    await waitFor(() => group.some(({ engine }) => engine.isLeader));
    const leader = group.find(({ engine }) => engine.isLeader);
    if (leader === undefined) {
      throw new Error("no leader");
    }
    const followers = group.filter((entry) => entry !== leader);
    followers.forEach(({ counting }) => {
      counting.reset();
    });

    await passesOnLeader(leader, 5);

    expect(group.filter(({ engine }) => engine.isLeader)).toEqual([leader]);
    const kinds = loopStatements(leader.counting);
    LOOP_STATEMENTS.forEach((pattern) => {
      expect(kinds.some((sql) => pattern.test(sql))).toBe(true);
    });
    followers.forEach(({ counting }) => {
      expect(loopStatements(counting)).toEqual([]);
    });
  });

  it("moves the loops to another engine when the leader stops", async () => {
    const group = [boot(), boot(), boot()];
    await waitFor(() => group.some(({ engine }) => engine.isLeader));
    const leader = group.find(({ engine }) => engine.isLeader);
    await leader?.engine.stop();
    const rest = group.filter((entry) => entry !== leader);

    await waitFor(() => rest.some(({ engine }) => engine.isLeader));
    const successor = rest.find(({ engine }) => engine.isLeader);
    successor?.counting.reset();
    if (successor !== undefined) {
      await passesOnLeader(successor, 3);
    }

    expect(rest.filter(({ engine }) => engine.isLeader)).toHaveLength(1);
    expect(leader?.engine.isLeader).toBe(false);
  });

  it("runs the loops on every engine with leader election turned off", async () => {
    const group = [boot({ leaderElection: false }), boot({ leaderElection: false })];

    await Promise.all(group.map((entry) => passesOnLeader(entry, 2)));

    expect(group.every(({ engine }) => engine.isLeader)).toBe(true);
  });
});
