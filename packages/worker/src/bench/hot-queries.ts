import type { Pool } from "@dee/core";

/**
 * A query the engine runs on its hot path, with the parameters to run it
 * with. `table` names the table whose scan type the index review checks.
 */
export interface HotQuery {
  readonly name: string;
  readonly table: string;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * How many runs `seedHotTables` creates. A twentieth of them stay open.
 */
export interface SeedScale {
  readonly runs: number;
}

/**
 * Fills a migrated schema with closed and open runs, four events per run and
 * one task per run and a timer for every open run, in the proportions of a busy installation: most runs are
 * closed and their tasks completed, a twentieth are open, and of those some
 * have a pending or leased task. Returns the namespace id and the queue name.
 */
export async function seedHotTables(
  pool: Pool,
  scale: SeedScale,
): Promise<{ namespaceId: string; queueName: string }> {
  const queueName = "bench/default";
  const namespace = await pool.query<{ id: string }>(
    "insert into namespaces (name) values ('hot') returning id",
  );
  const namespaceId = namespace.rows[0]?.id ?? "";
  await pool.query(
    `insert into workflow_runs (namespace_id, workflow_type, status, started_at, created_at, closed_at)
     select $1, 'bench',
            case when i % 20 = 0 then 'RUNNING' else 'COMPLETED' end,
            now() - (i * interval '1 second'), now() - (i * interval '1 second'),
            case when i % 20 = 0 then null else now() - (i * interval '1 second') end
     from generate_series(1, $2::int) as i`,
    [namespaceId, scale.runs],
  );
  await pool.query(
    `insert into run_events (run_id, sequence_number, event_type, payload)
     select r.id, s.n, (array['run_started', 'step_scheduled', 'step_completed', 'run_completed'])[s.n], '{}'::jsonb
     from workflow_runs r cross join generate_series(1, 4) as s (n)`,
  );
  await pool.query(
    `insert into tasks (namespace_id, run_id, queue_name, task_type, state, visible_at)
     select r.namespace_id, r.id, $1, 'STEP_TASK',
            case when r.status <> 'RUNNING' then 'COMPLETED'
                 when row_number() over (order by r.created_at) % 3 = 0 then 'PENDING'
                 when row_number() over (order by r.created_at) % 3 = 1 then 'LEASED'
                 else 'COMPLETED' end,
            now() - interval '1 minute'
     from workflow_runs r`,
    [queueName],
  );
  await pool.query(
    `insert into timers (run_id, timer_id, fire_at, state)
     select r.id, 'timer-1',
            case when row_number() over (order by r.created_at) % 50 = 0
                 then now() - interval '1 second'
                 else now() + interval '1 hour' end,
            'PENDING'
     from workflow_runs r where r.status = 'RUNNING'`,
  );
  await pool.query("analyze");
  return { namespaceId, queueName };
}

/**
 * The hot queries of the engine for a seeded namespace: the dequeue, the
 * sequence check and history read of every append, the janitor's reclaim and
 * stalled run scans, the timer poll, the run list and the metrics gauges.
 */
export function hotQueries(
  namespaceId: string,
  queueName: string,
  runId: string,
  now: Date,
): HotQuery[] {
  return [
    {
      name: "dequeue",
      table: "tasks",
      sql: `select id from tasks
            where queue_name = $1 and state in ('PENDING', 'LEASED') and visible_at <= $2
            order by visible_at, created_at, id
            limit 8
            for update skip locked`,
      params: [queueName, now],
    },
    {
      name: "sequence check",
      table: "run_events",
      sql: `select greatest(
              coalesce((select max(sequence_number) from run_events where run_id = $1), 0),
              coalesce((select last_sequence_number from run_snapshots where run_id = $1), 0)
            ) as seq`,
      params: [runId],
    },
    {
      name: "read history",
      table: "run_events",
      sql: `select sequence_number, payload::text as payload, created_at
            from run_events where run_id = $1 and sequence_number > $2
            order by sequence_number asc`,
      params: [runId, 0],
    },
    {
      name: "reclaim expired leases",
      table: "tasks",
      sql: `select id, leased_by, leased_by_version from tasks
            where state = 'LEASED' and visible_at <= $1
            for update skip locked`,
      params: [now],
    },
    {
      name: "stalled runs",
      table: "workflow_runs",
      sql: `select r.id from workflow_runs r
            where r.status = 'RUNNING'
              and coalesce((select max(e.created_at) from run_events e where e.run_id = r.id), r.created_at)
                  <= $1::timestamptz - $2 * interval '1 millisecond'
              and not exists (
                select 1 from tasks t
                where t.run_id = r.id and t.state in ('PENDING', 'LEASED', 'QUARANTINED')
              )
              and not exists (
                select 1 from timers m where m.run_id = r.id and m.state = 'PENDING'
              )
            order by r.created_at, r.id`,
      params: [now, 60_000],
    },
    {
      name: "due timers",
      table: "timers",
      sql: `select id, run_id, timer_id, fire_at, created_at from timers
            where state = 'PENDING' and fire_at <= $1
            order by fire_at, id
            limit 1
            for update skip locked`,
      params: [now],
    },
    {
      name: "list runs",
      table: "workflow_runs",
      sql: `select id, status, started_at from workflow_runs
            where namespace_id = $1
            order by started_at desc, id desc
            limit 50`,
      params: [namespaceId],
    },
    {
      name: "list open runs",
      table: "workflow_runs",
      sql: `select id, status, started_at from workflow_runs
            where namespace_id = $1 and status = 'RUNNING'
            order by started_at desc, id desc
            limit 50`,
      params: [namespaceId],
    },
    {
      name: "queue depth gauge",
      table: "tasks",
      sql: `select queue_name, count(*) as depth from tasks
            where state = 'PENDING' and visible_at <= $1 group by queue_name`,
      params: [now],
    },
    {
      name: "active workers gauge",
      table: "tasks",
      sql: `select count(distinct leased_by) as workers from tasks
            where state = 'LEASED' and leased_by is not null`,
      params: [],
    },
  ];
}

/**
 * What `EXPLAIN (ANALYZE, FORMAT JSON)` reported for one query.
 */
export interface QueryPlan {
  readonly name: string;
  readonly table: string;
  readonly executionMs: number;
  readonly rowsReturned: number;
  readonly nodeTypes: readonly string[];
  readonly sequentialScans: readonly string[];
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
}

function collectNodes(node: PlanNode, into: PlanNode[]): void {
  into.push(node);
  for (const child of node.Plans ?? []) {
    collectNodes(child, into);
  }
}

/**
 * Runs `EXPLAIN (ANALYZE, FORMAT JSON)` for `query` inside a transaction
 * that is rolled back, so queries that lock rows leave nothing behind.
 */
export async function explainQuery(pool: Pool, query: HotQuery): Promise<QueryPlan> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
    }>(`explain (analyze, format json) ${query.sql}`, [...query.params]);
    const report = result.rows[0]?.["QUERY PLAN"][0];
    if (report === undefined) {
      throw new Error(`explain of "${query.name}" returned no plan`);
    }
    const nodes: PlanNode[] = [];
    collectNodes(report.Plan, nodes);
    return {
      name: query.name,
      table: query.table,
      executionMs: report["Execution Time"],
      rowsReturned: report.Plan["Actual Rows"] ?? 0,
      nodeTypes: nodes.map((node) => node["Node Type"]),
      sequentialScans: nodes
        .filter((node) => node["Node Type"] === "Seq Scan")
        .map((node) => node["Relation Name"] ?? ""),
    };
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

/**
 * Explains every hot query of a seeded schema. `runId` should be a run with
 * events.
 */
export async function explainHotQueries(
  pool: Pool,
  seeded: { namespaceId: string; queueName: string },
): Promise<QueryPlan[]> {
  const run = await pool.query<{ id: string }>(
    "select id from workflow_runs where status = 'RUNNING' limit 1",
  );
  const queries = hotQueries(
    seeded.namespaceId,
    seeded.queueName,
    run.rows[0]?.id ?? "",
    new Date(),
  );
  const plans: QueryPlan[] = [];
  for (const query of queries) {
    plans.push(await explainQuery(pool, query));
  }
  return plans;
}
