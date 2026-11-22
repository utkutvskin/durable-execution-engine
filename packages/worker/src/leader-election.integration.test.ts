import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSessionConnector, type SessionConnector } from "@dee/core";
import { createIsolatedDatabase, type IsolatedSchema } from "../../core/src/db/test-harness.ts";
import { startLeaderElection, type LeaderElection } from "./leader-election.ts";
import { createVirtualTime, waitFor, type VirtualTime } from "./test-support.ts";

const LEASE_MS = 1000;

interface Candidate {
  readonly election: LeaderElection;
  readonly time: VirtualTime;
  readonly pids: number[];
  readonly events: string[];
}

describe("leader election through a session advisory lock", () => {
  let database: IsolatedSchema;
  let other: IsolatedSchema;
  const started: Candidate[] = [];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    other = await createIsolatedDatabase();
  });

  afterEach(async () => {
    await Promise.all(started.map((candidate) => candidate.election.stop()));
    started.length = 0;
  });

  afterAll(async () => {
    await database.close();
    await other.close();
  });

  function recording(connect: SessionConnector, pids: number[]): SessionConnector {
    return async () => {
      const session = await connect();
      const rows = await session.query<{ pid: number }>("select pg_backend_pid() as pid");
      pids.push(rows[0]?.pid ?? 0);
      return session;
    };
  }

  function candidate(target: IsolatedSchema = database, key = "default"): Candidate {
    const time = createVirtualTime();
    const pids: number[] = [];
    const events: string[] = [];
    const election = startLeaderElection({
      connect: recording(createSessionConnector(target.pool), pids),
      key,
      leasePeriodMs: LEASE_MS,
      timers: time.timers,
      onElected: () => {
        events.push("elected");
      },
      onDeposed: () => {
        events.push("deposed");
        return Promise.resolve();
      },
    });
    const entry = { election, time, pids, events };
    started.push(entry);
    return entry;
  }

  async function settled(candidates: readonly Candidate[]): Promise<void> {
    await waitFor(() => candidates.every((entry) => entry.time.pendingDelays().length === 1));
  }

  async function leasePeriod(candidates: readonly Candidate[]): Promise<void> {
    candidates.forEach((entry) => {
      entry.time.advance(LEASE_MS);
    });
    await settled(candidates);
  }

  function leaders(candidates: readonly Candidate[]): Candidate[] {
    return candidates.filter((entry) => entry.election.isLeader);
  }

  it("elects exactly one of three candidates and keeps it over many lease periods", async () => {
    const candidates = [candidate(), candidate(), candidate()];
    await settled(candidates);
    expect(leaders(candidates)).toHaveLength(1);
    const first = leaders(candidates)[0];

    for (let period = 0; period < 5; period += 1) {
      await leasePeriod(candidates);
      expect(leaders(candidates)).toEqual([first]);
    }
    expect(first?.events).toEqual(["elected"]);
  });

  it("replaces a killed leader within two lease periods", async () => {
    const candidates = [candidate(), candidate(), candidate()];
    await settled(candidates);
    const [killed] = leaders(candidates);
    const pid = killed?.pids[0] ?? 0;
    const survivors = candidates.filter((entry) => entry !== killed);

    await database.pool.query("select pg_terminate_backend($1)", [pid]);
    await waitFor(async () => {
      const alive = await database.pool.query("select 1 from pg_stat_activity where pid = $1", [
        pid,
      ]);
      return alive.rowCount === 0;
    });

    let periods = 0;
    while (leaders(survivors).length === 0 && periods < 2) {
      await leasePeriod(survivors);
      periods += 1;
    }
    expect(leaders(survivors)).toHaveLength(1);
    expect(periods).toBeLessThanOrEqual(2);
  });

  it("steps a leader down at once when its session is lost", async () => {
    const leader = candidate();
    await settled([leader]);
    expect(leader.election.isLeader).toBe(true);

    await database.pool.query("select pg_terminate_backend($1)", [leader.pids[0]]);
    await waitFor(() => !leader.election.isLeader);

    expect(leader.events).toEqual(["elected", "deposed"]);
    await leasePeriod([leader]);
    expect(leader.election.isLeader).toBe(true);
    expect(leader.pids).toHaveLength(2);
  });

  it("hands leadership over on the next attempt after the leader stops", async () => {
    const candidates = [candidate(), candidate()];
    await settled(candidates);
    const [leader] = leaders(candidates);
    const follower = candidates.find((entry) => entry !== leader);

    await leader?.election.stop();
    expect(leader?.events).toEqual(["elected", "deposed"]);
    await leasePeriod(follower === undefined ? [] : [follower]);

    expect(follower?.election.isLeader).toBe(true);
  });

  it("elects one leader per key and per schema", async () => {
    const candidates = [
      candidate(database, "orders"),
      candidate(database, "orders"),
      candidate(database, "emails"),
      candidate(other, "orders"),
    ];
    await settled(candidates);

    expect(leaders(candidates.slice(0, 2))).toHaveLength(1);
    expect(candidates[2]?.election.isLeader).toBe(true);
    expect(candidates[3]?.election.isLeader).toBe(true);
  });
});
