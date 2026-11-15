import { compileVisibilityQuery, type Pool } from "@dee/core";
import { explainQuery, type HotQuery, type QueryPlan } from "./hot-queries.ts";

/**
 * The page size `GET /v1/runs` asks Postgres for by default: 50 runs plus
 * one to know whether a next page exists.
 */
export const VISIBILITY_PAGE_ROWS = 51;

/**
 * Fills a migrated schema with `runs` runs of one namespace, each with
 * search attributes: `customerId` (997 customers), `amount` (0 to 999),
 * `region` (eu, us or apac) and `vip` (one run in 50). One run in 20 failed,
 * one in 20 is open, the rest completed, one run started per second going
 * back from now. Returns the namespace id.
 */
export async function seedVisibilityRuns(pool: Pool, runs: number): Promise<string> {
  const namespace = await pool.query<{ id: string }>(
    "insert into namespaces (name) values ('visibility') returning id",
  );
  const namespaceId = namespace.rows[0]?.id ?? "";
  await pool.query(
    `insert into workflow_runs
       (namespace_id, workflow_type, status, started_at, created_at, closed_at, search_attributes)
     select $1,
            case when i % 4 = 0 then 'payment' else 'order' end,
            case when i % 20 = 0 then 'FAILED' when i % 20 = 1 then 'RUNNING' else 'COMPLETED' end,
            now() - (i * interval '1 second'), now() - (i * interval '1 second'),
            case when i % 20 = 1 then null else now() - (i * interval '1 second') end,
            jsonb_build_object(
              'customerId', 'c-' || (i % 997),
              'amount', (i * 7) % 1000,
              'region', (array['eu', 'us', 'apac'])[i % 3 + 1],
              'vip', i % 50 = 0
            )
     from generate_series(1, $2::int) as i`,
    [namespaceId, runs],
  );
  await pool.query("analyze workflow_runs");
  return namespaceId;
}

/**
 * The visibility queries the benchmark measures, from the example of the
 * backlog to a filter no index can serve.
 */
export function visibilityQueries(now: Date): readonly { name: string; query: string }[] {
  const halfDayAgo = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  return [
    {
      name: "status, customer and start time",
      query: `status = 'FAILED' and customerId = 'c-1' and startedAt > '${halfDayAgo}'`,
    },
    { name: "one customer", query: "customerId = 'c-17'" },
    { name: "no match", query: "customerId = 'nobody'" },
    { name: "status and amount range", query: "status = 'FAILED' and amount > 900" },
    { name: "either of two attributes", query: "vip = true or customerId = 'c-3'" },
    { name: "rare amount, no index", query: "amount > 998" },
  ];
}

/**
 * The statement `GET /v1/runs?query=...` sends for `query`: the namespace
 * condition, the compiled query and the newest first page.
 */
export function visibilityListQuery(name: string, namespaceId: string, query: string): HotQuery {
  const compiled = compileVisibilityQuery(query, 2);
  return {
    name,
    table: "workflow_runs",
    sql: `select id, workflow_type, status, input, result, error, started_at, closed_at,
                 last_sequence_number, idempotency_key, search_attributes, memo
          from workflow_runs
          where namespace_id = $1 and ${compiled.sql}
          order by started_at desc, id desc
          limit ${String(VISIBILITY_PAGE_ROWS)}`,
    params: [namespaceId, ...compiled.values],
  };
}

/**
 * One measured visibility query: its plan and the median and slowest wall
 * time of `rounds` executions as the api runs it.
 */
export interface VisibilityMeasurement {
  readonly query: string;
  readonly plan: QueryPlan;
  readonly medianMs: number;
  readonly maxMs: number;
  readonly text: string;
}

/**
 * The text form of `EXPLAIN (ANALYZE, COSTS OFF)` for `statement`, the
 * evidence `docs/BENCHMARKS.md` quotes.
 */
export async function explainText(pool: Pool, statement: HotQuery): Promise<string> {
  const result = await pool.query<{ "QUERY PLAN": string }>(
    `explain (analyze, costs off, timing on) ${statement.sql}`,
    [...statement.params],
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/**
 * Explains every visibility query and times `rounds` executions of each.
 */
export async function measureVisibilityQueries(
  pool: Pool,
  namespaceId: string,
  rounds: number,
): Promise<VisibilityMeasurement[]> {
  const measured: VisibilityMeasurement[] = [];
  for (const { name, query } of visibilityQueries(new Date())) {
    const statement = visibilityListQuery(name, namespaceId, query);
    const plan = await explainQuery(pool, statement);
    const times: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const started = performance.now();
      await pool.query(statement.sql, [...statement.params]);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    measured.push({
      query,
      plan,
      text: await explainText(pool, statement),
      medianMs: times[Math.floor(times.length / 2)] ?? 0,
      maxMs: times.at(-1) ?? 0,
    });
  }
  return measured;
}
