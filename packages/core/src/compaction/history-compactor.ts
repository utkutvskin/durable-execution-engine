import type { Pool } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.js";
import { readEventsOnClient } from "../event-store/event-store.js";
import { createInitialProjection, foldRunEvents } from "../run/projection.js";
import { RUN_STATES, type RunState } from "../run/state-machine.js";
import type { ClockSource } from "../workflow/sources.js";
import { readSnapshotOnClient, serializeProjection, type RunSnapshot } from "./snapshot.js";

/**
 * How long a closed run keeps its full history, and how much of it survives
 * pruning. `closedRunRetentionMs` is the age (since the run closed) at which
 * a sweep compacts it. `tailEvents` is how many of the run's last events stay
 * in `run_events` after pruning (0 prunes the whole history).
 */
export interface RetentionPolicy {
  readonly closedRunRetentionMs: number;
  readonly tailEvents: number;
}

/**
 * The outcome of compacting one run. `compacted` is false for a run that is
 * still open or missing, which is never touched.
 */
export interface CompactionResult {
  readonly runId: string;
  readonly compacted: boolean;
  readonly prunedEvents: number;
  readonly snapshot?: RunSnapshot;
}

/**
 * What one sweep did: how many runs it compacted and how many events it
 * deleted.
 */
export interface CompactionReport {
  readonly runsCompacted: number;
  readonly eventsPruned: number;
}

/**
 * Writes snapshots for closed runs and prunes the events a snapshot replaces.
 */
export interface HistoryCompactor {
  /**
   * Folds the run's history up to the cut point (all but the last
   * `tailEvents` events) into a snapshot, stores it and deletes those events,
   * in one transaction under the run row lock. An open run is left alone.
   * Compacting a run twice prunes nothing the second time.
   */
  compactRun(runId: string): Promise<CompactionResult>;

  /**
   * Compacts up to `batchSize` closed runs that have no snapshot yet and
   * closed at least `closedRunRetentionMs` before the clock's now, oldest
   * first.
   */
  sweep(batchSize?: number): Promise<CompactionReport>;
}

/**
 * Options for `createHistoryCompactor`.
 */
export interface HistoryCompactorOptions {
  readonly clock: ClockSource;
  readonly policy: RetentionPolicy;
  readonly codec?: Codec;
}

const DEFAULT_SWEEP_BATCH = 100;

function assertPolicy(policy: RetentionPolicy): void {
  if (!Number.isFinite(policy.closedRunRetentionMs) || policy.closedRunRetentionMs < 0) {
    throw new RangeError("closedRunRetentionMs must be zero or positive");
  }
  if (!Number.isInteger(policy.tailEvents) || policy.tailEvents < 0) {
    throw new RangeError("tailEvents must be a non-negative integer");
  }
}

function isRunState(status: string): status is RunState {
  return RUN_STATES.some((state) => state === status);
}

/**
 * Creates a `HistoryCompactor` over `pool`. Only closed runs are compacted:
 * the decision loop replays an open run from its first event, so its history
 * cannot be pruned, and a long-lived workflow bounds its history by
 * continuing as new instead.
 */
export function createHistoryCompactor(
  pool: Pool,
  options: HistoryCompactorOptions,
): HistoryCompactor {
  assertPolicy(options.policy);
  const codec = options.codec ?? jsonCodec;

  async function compactRun(runId: string): Promise<CompactionResult> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const run = await client.query<{ status: string }>(
        "select status from workflow_runs where id = $1 for update",
        [runId],
      );
      const status = run.rows[0]?.status;
      if (status === undefined || !isRunState(status) || status === "RUNNING") {
        await client.query("commit");
        return { runId, compacted: false, prunedEvents: 0 };
      }
      const previous = await readSnapshotOnClient(client, runId);
      const start = previous?.projection ?? createInitialProjection();
      const events = await readEventsOnClient(client, codec, runId, start.lastSequenceNumber);
      const cutIndex = Math.max(events.length - options.policy.tailEvents, 0);
      const pruned = events.slice(0, cutIndex);
      const projection = foldRunEvents(pruned, start);
      const prunedEventCount = (previous?.prunedEventCount ?? 0) + pruned.length;
      await client.query(
        `insert into run_snapshots (run_id, last_sequence_number, pruned_event_count, projection)
         values ($1, $2, $3, $4::jsonb)
         on conflict (run_id) do update
           set last_sequence_number = excluded.last_sequence_number,
               pruned_event_count = excluded.pruned_event_count,
               projection = excluded.projection,
               created_at = now()`,
        [runId, projection.lastSequenceNumber, prunedEventCount, serializeProjection(projection)],
      );
      await client.query("delete from run_events where run_id = $1 and sequence_number <= $2", [
        runId,
        projection.lastSequenceNumber,
      ]);
      await client.query("commit");
      return {
        runId,
        compacted: true,
        prunedEvents: pruned.length,
        snapshot: {
          runId,
          lastSequenceNumber: projection.lastSequenceNumber,
          prunedEventCount,
          projection,
        },
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    compactRun,

    async sweep(batchSize = DEFAULT_SWEEP_BATCH): Promise<CompactionReport> {
      const cutoff = new Date(options.clock.now().getTime() - options.policy.closedRunRetentionMs);
      const candidates = await pool.query<{ id: string }>(
        `select w.id from workflow_runs w
         where w.status <> 'RUNNING' and w.closed_at <= $1
           and not exists (select 1 from run_snapshots s where s.run_id = w.id)
         order by w.closed_at asc, w.id asc
         limit $2`,
        [cutoff, batchSize],
      );
      let runsCompacted = 0;
      let eventsPruned = 0;
      for (const candidate of candidates.rows) {
        const result = await compactRun(candidate.id);
        if (result.compacted) {
          runsCompacted += 1;
          eventsPruned += result.prunedEvents;
        }
      }
      return { runsCompacted, eventsPruned };
    },
  };
}
