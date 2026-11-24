import type { Pool, PoolClient } from "pg";
import { jsonCodec, type Codec } from "../event-store/codec.ts";
import { rollbackQuietly } from "../db/transaction.ts";
import { systemClock, type ClockSource } from "../workflow/sources.ts";
import {
  archiveHeaderLine,
  type ArchivedEvent,
  type ArchivedPartition,
  type RunEventArchive,
} from "./run-event-archive.ts";

/**
 * How many days of `run_events` partitions the maintainer keeps created
 * ahead of today, so new runs never land in the default partition.
 */
export const DEFAULT_PARTITION_AHEAD_DAYS = 7;

/**
 * How long after a partition's range ends before it may be dropped, so a
 * run created by a transaction that started just before the boundary has
 * committed.
 */
export const DEFAULT_PARTITION_SETTLE_MS = 60 * 60_000;

const DEFAULT_ARCHIVE_BATCH_SIZE = 1000;
const DETACH_LOCK_TIMEOUT = "5s";

/**
 * Options for `createPartitionMaintainer`.
 *
 * - `aheadDays`: the days of partitions created ahead of today (default
 *   `DEFAULT_PARTITION_AHEAD_DAYS`).
 * - `archive`: where a partition is written before it is dropped. Without
 *   it, a partition whose runs are all purged is dropped without a copy.
 * - `codec`: decodes stored payloads for the archive (default `jsonCodec`).
 * - `settleMs`: see `DEFAULT_PARTITION_SETTLE_MS`.
 * - `batchSize`: events read per statement while archiving (default 1000).
 */
export interface PartitionMaintainerOptions {
  readonly clock?: ClockSource;
  readonly aheadDays?: number;
  readonly archive?: RunEventArchive;
  readonly codec?: Codec;
  readonly settleMs?: number;
  readonly batchSize?: number;
}

/**
 * A partition the maintainer dropped, with the archive it wrote first (when
 * one is configured) and the number of events it held.
 */
export interface DroppedPartition {
  readonly name: string;
  readonly events: number;
  readonly archivedTo: string | null;
}

/**
 * A partition that was due to be dropped but was kept, and why: its event
 * count changed while it was being archived, the detach could not take its
 * lock in time, or the archive failed.
 */
export interface KeptPartition {
  readonly name: string;
  readonly reason: string;
}

/**
 * What one `PartitionMaintainer.runOnce` did.
 */
export interface PartitionMaintenanceReport {
  readonly created: readonly string[];
  readonly dropped: readonly DroppedPartition[];
  readonly kept: readonly KeptPartition[];
}

/**
 * One partition of `run_events` as `run_event_partitions` records it.
 */
export interface RunEventPartition extends ArchivedPartition {
  readonly archivedTo: string | null;
  readonly droppedAt: Date | null;
}

/**
 * Keeps `run_events` partitioned by the creation day of each run (UTC):
 * creates the partitions ahead of time, and detaches and drops a partition
 * once every run created in its range was purged by retention, writing it
 * to the archive first. Runs on the elected engine.
 */
export interface PartitionMaintainer {
  runOnce(): Promise<PartitionMaintenanceReport>;
  listPartitions(): Promise<RunEventPartition[]>;
}

interface PartitionRow {
  name: string;
  lower_bound: Date | null;
  upper_bound: Date;
  archived_to: string | null;
  dropped_at: Date | null;
}

interface ArchivedEventRow {
  run_id: string;
  sequence_number: string;
  created_at: Date;
  event_version: number;
  payload: string;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function toPartition(row: PartitionRow): RunEventPartition {
  return {
    name: row.name,
    lowerBound: row.lower_bound,
    upperBound: row.upper_bound,
    archivedTo: row.archived_to,
    droppedAt: row.dropped_at,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the maintainer of `run_events`' partitions over `pool`.
 */
export function createPartitionMaintainer(
  pool: Pool,
  options: PartitionMaintainerOptions = {},
): PartitionMaintainer {
  const clock = options.clock ?? systemClock;
  const aheadDays = options.aheadDays ?? DEFAULT_PARTITION_AHEAD_DAYS;
  const settleMs = options.settleMs ?? DEFAULT_PARTITION_SETTLE_MS;
  const codec = options.codec ?? jsonCodec;
  const batchSize = options.batchSize ?? DEFAULT_ARCHIVE_BATCH_SIZE;

  async function* archiveLines(
    partition: ArchivedPartition,
    archivedAt: Date,
    counted: { events: number },
  ): AsyncGenerator<string> {
    yield archiveHeaderLine(partition, archivedAt);
    let after: { runId: string; sequenceNumber: string } | undefined;
    for (;;) {
      const result = await pool.query<ArchivedEventRow>(
        `select run_id, sequence_number, created_at, event_version, payload::text as payload
         from ${quoteIdentifier(partition.name)}
         where ($1::uuid is null or (run_id, sequence_number) > ($1::uuid, $2::bigint))
         order by run_id, sequence_number
         limit $3`,
        [after?.runId ?? null, after?.sequenceNumber ?? null, batchSize],
      );
      for (const row of result.rows) {
        const line: ArchivedEvent = {
          runId: row.run_id,
          sequenceNumber: Number(row.sequence_number),
          createdAt: row.created_at.toISOString(),
          version: row.event_version,
          event: codec.decode(row.payload) as ArchivedEvent["event"],
        };
        counted.events += 1;
        yield JSON.stringify(line);
      }
      const last = result.rows.at(-1);
      if (last === undefined || result.rows.length < batchSize) {
        return;
      }
      after = { runId: last.run_id, sequenceNumber: last.sequence_number };
    }
  }

  async function countEvents(client: Pool | PoolClient, name: string): Promise<number> {
    const result = await client.query<{ events: string }>(
      `select count(*) as events from ${quoteIdentifier(name)}`,
    );
    return Number(result.rows[0]?.events ?? "0");
  }

  async function detachAndDrop(
    partition: ArchivedPartition,
    expectedEvents: number,
    archivedTo: string | null,
  ): Promise<DroppedPartition | KeptPartition> {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      await client.query(`set local lock_timeout = '${DETACH_LOCK_TIMEOUT}'`);
      await client.query(
        `alter table run_events detach partition ${quoteIdentifier(partition.name)}`,
      );
      const events = await countEvents(client, partition.name);
      if (events !== expectedEvents) {
        await client.query("rollback");
        return {
          name: partition.name,
          reason: `it held ${String(events)} events after archiving ${String(expectedEvents)}`,
        };
      }
      await client.query(`drop table ${quoteIdentifier(partition.name)}`);
      await client.query(
        `update run_event_partitions
         set dropped_at = $2, archived_to = $3, archived_events = $4
         where name = $1`,
        [partition.name, clock.now(), archivedTo, events],
      );
      await client.query("commit");
      return { name: partition.name, events, archivedTo };
    } catch (error) {
      broken = !(await rollbackQuietly(client));
      return { name: partition.name, reason: errorMessage(error) };
    } finally {
      client.release(broken);
    }
  }

  async function retire(partition: ArchivedPartition): Promise<DroppedPartition | KeptPartition> {
    if (options.archive === undefined) {
      return detachAndDrop(partition, await countEvents(pool, partition.name), null);
    }
    const counted = { events: 0 };
    let archivedTo: string;
    try {
      archivedTo = await options.archive.write(
        partition,
        archiveLines(partition, clock.now(), counted),
      );
    } catch (error) {
      return { name: partition.name, reason: `the archive failed: ${errorMessage(error)}` };
    }
    await pool.query("update run_event_partitions set archived_to = $2 where name = $1", [
      partition.name,
      archivedTo,
    ]);
    return detachAndDrop(partition, counted.events, archivedTo);
  }

  return {
    async runOnce() {
      const now = clock.now();
      const created = await pool.query<{ name: string }>(
        "select ensure_run_event_partitions($1, $2) as name",
        [now, aheadDays],
      );
      const due = await pool.query<PartitionRow>(
        `select p.name, p.lower_bound, p.upper_bound, p.archived_to, p.dropped_at
         from run_event_partitions p
         where p.dropped_at is null and p.upper_bound <= $1
           and not exists (
             select 1 from workflow_runs run
             where run.purged_at is null and run.created_at < p.upper_bound
               and (p.lower_bound is null or run.created_at >= p.lower_bound)
           )
         order by p.upper_bound`,
        [new Date(now.getTime() - settleMs)],
      );
      const dropped: DroppedPartition[] = [];
      const kept: KeptPartition[] = [];
      for (const row of due.rows) {
        const outcome = await retire(toPartition(row));
        if ("reason" in outcome) {
          kept.push(outcome);
        } else {
          dropped.push(outcome);
        }
      }
      return { created: created.rows.map((row) => row.name), dropped, kept };
    },

    async listPartitions() {
      const result = await pool.query<PartitionRow>(
        `select name, lower_bound, upper_bound, archived_to, dropped_at
         from run_event_partitions order by upper_bound`,
      );
      return result.rows.map(toPartition);
    },
  };
}
