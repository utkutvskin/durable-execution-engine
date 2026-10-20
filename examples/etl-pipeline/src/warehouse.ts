/**
 * A row of the source system.
 */
export interface SourceRow {
  readonly id: string;
  readonly amountCents: number;
  readonly currency: string;
}

/**
 * A row as it is stored in the destination.
 */
export interface TargetRow {
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly day: string;
}

/**
 * The shape of the data the in-memory warehouse serves. `partitions` source
 * partitions of `rowsPerPartition` rows each exist for every day; every
 * `invalidEvery`th row has a negative amount and is rejected by the
 * transform. `failFirstExtract` names partitions whose first extract fails
 * with a transient error.
 */
export interface WarehouseOptions {
  readonly partitions?: number;
  readonly rowsPerPartition?: number;
  readonly invalidEvery?: number;
  readonly failFirstExtract?: readonly string[];
}

/**
 * A source and a destination held in memory, with the counters the example
 * and its tests check.
 */
export interface Warehouse {
  /** The partitions of `day`, in a stable order. */
  listPartitions(day: string): string[];
  /** The rows of one partition. Fails once for the partitions named in `failFirstExtract`. */
  extract(partition: string): SourceRow[];
  /** Upserts rows by id, so loading a row twice leaves one row. Returns how many were new. */
  load(rows: readonly TargetRow[]): number;
  /** Stores the summary of a day, replacing an earlier one. */
  writeSummary(day: string, summary: DaySummary): void;
  /** Every loaded row by id. */
  loadedRows(): ReadonlyMap<string, TargetRow>;
  /** The summary written for each day. */
  summaries(): ReadonlyMap<string, DaySummary>;
  /** How many times each partition was extracted, failures included. */
  extractCalls(): ReadonlyMap<string, number>;
  /** How many `load` calls ran. */
  loadCalls(): number;
  /** Forgets the destination and the counters, keeping the source. */
  reset(): void;
}

/**
 * What the pipeline wrote about a finished day.
 */
export interface DaySummary {
  readonly day: string;
  readonly partitions: number;
  readonly extracted: number;
  readonly loaded: number;
  readonly rejected: number;
}

/**
 * The partition id of the `index`th partition of `day`.
 */
export function partitionId(day: string, index: number): string {
  return `${day}/p${String(index)}`;
}

/**
 * Creates an in-memory `Warehouse`.
 */
export function createWarehouse(options: WarehouseOptions = {}): Warehouse {
  const partitions = options.partitions ?? 4;
  const rowsPerPartition = options.rowsPerPartition ?? 25;
  const invalidEvery = options.invalidEvery ?? 10;
  const flaky = new Set(options.failFirstExtract ?? []);
  const target = new Map<string, TargetRow>();
  const written = new Map<string, DaySummary>();
  const extracted = new Map<string, number>();
  let loads = 0;

  return {
    listPartitions(day) {
      return Array.from({ length: partitions }, (_, index) => partitionId(day, index));
    },
    extract(partition) {
      const attempt = (extracted.get(partition) ?? 0) + 1;
      extracted.set(partition, attempt);
      if (attempt === 1 && [...flaky].some((suffix) => partition.endsWith(suffix))) {
        throw new Error(`the source timed out reading ${partition}`);
      }
      return Array.from({ length: rowsPerPartition }, (_, index) => ({
        id: `${partition}#${String(index)}`,
        amountCents: (index + 1) % invalidEvery === 0 ? -1 : 100 * (index + 1),
        currency: "EUR",
      }));
    },
    load(rows) {
      loads += 1;
      let inserted = 0;
      for (const row of rows) {
        if (!target.has(row.id)) {
          inserted += 1;
        }
        target.set(row.id, row);
      }
      return inserted;
    },
    writeSummary(day, summary) {
      written.set(day, summary);
    },
    loadedRows: () => new Map(target),
    summaries: () => new Map(written),
    extractCalls: () => new Map(extracted),
    loadCalls: () => loads,
    reset() {
      target.clear();
      written.clear();
      extracted.clear();
      loads = 0;
    },
  };
}
