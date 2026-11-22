import type { SessionConnection, SessionConnector } from "@dee/core";
import { systemTimers, type Timers } from "./timers.ts";

/**
 * Configuration for `startLeaderElection`.
 *
 * - `connect`: opens the dedicated session that holds the lock.
 * - `key`: what is led, such as a queue name. Candidates with the same key
 *   and the same Postgres schema compete for one lock.
 * - `leasePeriodMs`: how often a follower tries to take the lock and a
 *   leader checks that its session is alive (default 1000). A leader that
 *   was killed is replaced within two lease periods.
 * - `onElected` runs when this candidate becomes the leader and
 *   `onDeposed` when it stops being one, either because its session was
 *   lost or because the election is stopped; leadership is not tried again
 *   until `onDeposed` resolved.
 * - `onError` receives the errors the election survives.
 */
export interface LeaderElectionOptions {
  readonly connect: SessionConnector;
  readonly key: string;
  readonly leasePeriodMs?: number;
  readonly timers?: Timers;
  readonly onElected: () => void;
  readonly onDeposed: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running candidacy.
 */
export interface LeaderElection {
  /** Whether this candidate holds the lock right now. */
  readonly isLeader: boolean;
  /** Steps down if leading, ends the session and stops trying. */
  stop(): Promise<void>;
}

/**
 * The default lease period of `startLeaderElection`.
 */
export const DEFAULT_LEADER_LEASE_MS = 1000;

/**
 * Elects one leader among the candidates for `key` through a session
 * advisory lock (`pg_try_advisory_lock`, keyed by the current schema and
 * `key`), held on a dedicated session. The lock is released the moment that
 * session ends, so a leader whose process dies is replaced by the first
 * follower attempt after Postgres notices the closed connection; a leader
 * that loses its session steps down at once.
 *
 * Each candidate makes its first attempt immediately and then one attempt
 * or liveness check per `leasePeriodMs`.
 */
export function startLeaderElection(options: LeaderElectionOptions): LeaderElection {
  const leasePeriodMs = options.leasePeriodMs ?? DEFAULT_LEADER_LEASE_MS;
  if (!Number.isInteger(leasePeriodMs) || leasePeriodMs <= 0) {
    throw new RangeError(`leasePeriodMs must be a positive integer, got ${String(leasePeriodMs)}`);
  }
  const timers = options.timers ?? systemTimers;
  const onError = options.onError ?? ((): void => undefined);
  let session: SessionConnection | undefined;
  let leader = false;
  let stopped = false;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();
  const isStopped = (): boolean => stopped;

  async function stepDown(): Promise<void> {
    if (!leader) {
      return;
    }
    leader = false;
    try {
      await options.onDeposed();
    } catch (error) {
      onError(error);
    }
  }

  async function dropSession(target: SessionConnection | undefined): Promise<void> {
    if (target === undefined || session !== target) {
      return;
    }
    session = undefined;
    await stepDown();
    await target.close().catch(onError);
  }

  async function openSession(): Promise<SessionConnection> {
    const opened = await options.connect();
    opened.onLost((error) => {
      if (session !== opened) {
        return;
      }
      onError(error);
      current = current.then(() => dropSession(opened));
    });
    session = opened;
    return opened;
  }

  async function attempt(): Promise<void> {
    handle = undefined;
    if (stopped) {
      return;
    }
    let active: SessionConnection | undefined;
    try {
      active = session ?? (await openSession());
      if (leader) {
        await active.query("select 1");
      } else {
        const rows = await active.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtext(current_schema()), hashtext($1)) as locked",
          [`dee.leader:${options.key}`],
        );
        if (rows[0]?.locked === true && !isStopped() && session === active) {
          leader = true;
          try {
            options.onElected();
          } catch (error) {
            onError(error);
          }
        }
      }
    } catch (error) {
      onError(error);
      await dropSession(active);
    }
    schedule();
  }

  function schedule(): void {
    if (stopped) {
      return;
    }
    handle = timers.setTimeout(() => {
      current = current.then(attempt);
    }, leasePeriodMs);
  }

  current = attempt();

  return {
    get isLeader(): boolean {
      return leader;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
      await current;
      await dropSession(session);
    },
  };
}
