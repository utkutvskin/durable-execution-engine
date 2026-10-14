import type { Pool } from "pg";

/**
 * The limits of one namespace. A `null` limit is not enforced.
 */
export interface NamespaceQuota {
  readonly maxConcurrentRuns: number | null;
  readonly maxPendingTasks: number | null;
  readonly ratePerSecond: number | null;
  readonly burst: number | null;
}

/**
 * What a namespace currently uses: runs in `RUNNING` and tasks that are
 * `PENDING` or `LEASED`.
 */
export interface NamespaceUsage {
  readonly openRuns: number;
  readonly pendingTasks: number;
}

/**
 * Reads and writes namespace quotas and measures the usage they limit.
 */
export interface QuotaStore {
  /** Resolves the quota of a namespace; a namespace without a row is unlimited. */
  get(namespaceId: string): Promise<NamespaceQuota>;

  /** Replaces the quota of a namespace. */
  set(namespaceId: string, quota: Partial<NamespaceQuota>): Promise<NamespaceQuota>;

  usage(namespaceId: string): Promise<NamespaceUsage>;

  /** The number of deliverable tasks of a queue, across all namespaces. */
  queueDepth(queueName: string): Promise<number>;
}

/**
 * A namespace with no limits.
 */
export const UNLIMITED_QUOTA: NamespaceQuota = {
  maxConcurrentRuns: null,
  maxPendingTasks: null,
  ratePerSecond: null,
  burst: null,
};

interface QuotaRow {
  max_concurrent_runs: number | null;
  max_pending_tasks: number | null;
  rate_per_second: number | null;
  burst: number | null;
}

function toQuota(row: QuotaRow): NamespaceQuota {
  return {
    maxConcurrentRuns: row.max_concurrent_runs,
    maxPendingTasks: row.max_pending_tasks,
    ratePerSecond: row.rate_per_second,
    burst: row.burst,
  };
}

/**
 * Creates a `QuotaStore` over `pool`.
 */
export function createQuotaStore(pool: Pool): QuotaStore {
  return {
    async get(namespaceId: string): Promise<NamespaceQuota> {
      const result = await pool.query<QuotaRow>(
        `select max_concurrent_runs, max_pending_tasks, rate_per_second, burst
         from namespace_quotas where namespace_id = $1`,
        [namespaceId],
      );
      const row = result.rows[0];
      return row === undefined ? UNLIMITED_QUOTA : toQuota(row);
    },

    async set(namespaceId: string, quota: Partial<NamespaceQuota>): Promise<NamespaceQuota> {
      const merged = { ...UNLIMITED_QUOTA, ...quota };
      const result = await pool.query<QuotaRow>(
        `insert into namespace_quotas
           (namespace_id, max_concurrent_runs, max_pending_tasks, rate_per_second, burst)
         values ($1, $2, $3, $4, $5)
         on conflict (namespace_id) do update
         set max_concurrent_runs = excluded.max_concurrent_runs,
             max_pending_tasks = excluded.max_pending_tasks,
             rate_per_second = excluded.rate_per_second,
             burst = excluded.burst,
             updated_at = now()
         returning max_concurrent_runs, max_pending_tasks, rate_per_second, burst`,
        [
          namespaceId,
          merged.maxConcurrentRuns,
          merged.maxPendingTasks,
          merged.ratePerSecond,
          merged.burst,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("quota upsert returned no row");
      }
      return toQuota(row);
    },

    async usage(namespaceId: string): Promise<NamespaceUsage> {
      const result = await pool.query<{ open_runs: string; pending_tasks: string }>(
        `select
           (select count(*) from workflow_runs where namespace_id = $1 and status = 'RUNNING')
             as open_runs,
           (select count(*) from tasks where namespace_id = $1 and state in ('PENDING', 'LEASED'))
             as pending_tasks`,
        [namespaceId],
      );
      const row = result.rows[0];
      return {
        openRuns: Number(row?.open_runs ?? 0),
        pendingTasks: Number(row?.pending_tasks ?? 0),
      };
    },

    async queueDepth(queueName: string): Promise<number> {
      const result = await pool.query<{ depth: string }>(
        `select count(*) as depth from tasks where queue_name = $1 and state = 'PENDING'`,
        [queueName],
      );
      return Number(result.rows[0]?.depth ?? 0);
    },
  };
}
