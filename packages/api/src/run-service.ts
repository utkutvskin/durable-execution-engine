import { isDeepStrictEqual } from "node:util";
import {
  RunNotFoundError,
  appendEventsOnClient,
  createPostgresEventStore,
  createRunControl,
  createRunInteractions,
  createWorkflowRegistry,
  jsonCodec,
  systemClock,
  systemRandomSource,
  type Pool,
  type RunControl,
  type RunInteractions,
  type WorkflowEvent,
} from "@dee/core";

/**
 * Raised when a start request reuses an idempotency key with a different
 * workflow type or input than the run that key created.
 */
export class IdempotencyConflictError extends Error {
  readonly idempotencyKey: string;
  readonly runId: string;

  constructor(idempotencyKey: string, runId: string) {
    super(
      `idempotency key "${idempotencyKey}" already started run "${runId}" with a different workflow type or input`,
    );
    this.name = "IdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
    this.runId = runId;
  }
}

/**
 * Raised when a pagination cursor is not one this service issued.
 */
export class InvalidCursorError extends Error {
  constructor() {
    super("the pagination cursor is malformed; request the first page again");
    this.name = "InvalidCursorError";
  }
}

/**
 * The fields of a run that a list shows.
 */
export interface RunSummary {
  readonly runId: string;
  readonly workflowType: string;
  readonly status: string;
  readonly startedAt: string;
  readonly closedAt: string | null;
}

/**
 * Everything the projection of a run knows.
 */
export interface RunDescription extends RunSummary {
  readonly input: unknown;
  readonly result: unknown;
  readonly error: { readonly name: string; readonly message: string } | null;
  readonly lastSequenceNumber: number;
  readonly idempotencyKey: string | null;
}

/**
 * Input of `startRun`.
 */
export interface StartRunInput {
  readonly workflowType: string;
  readonly input?: unknown;
  readonly idempotencyKey?: string;
}

/**
 * What `startRun` returns. `created` is false when the idempotency key had
 * already started the run.
 */
export interface StartRunResult {
  readonly created: boolean;
  readonly run: RunDescription;
}

/**
 * Filters and paging of `listRuns`.
 */
export interface ListRunsInput {
  readonly status?: string | undefined;
  readonly workflowType?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

/**
 * One page of runs, newest first. `nextCursor` is absent on the last page.
 */
export interface RunPage {
  readonly runs: readonly RunSummary[];
  readonly nextCursor?: string;
}

/**
 * One event of a run's history.
 */
export interface HistoryEntry {
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly event: WorkflowEvent;
}

/**
 * The operations behind the endpoints. Every method takes the caller's
 * namespace id first and filters on it: a run of another namespace is
 * reported exactly like a run that does not exist.
 */
export interface RunService {
  /**
   * Starts a run, or returns the run the same idempotency key started
   * before. Rejects with `IdempotencyConflictError` when the key was used
   * for a different request.
   */
  startRun(namespaceId: string, input: StartRunInput): Promise<StartRunResult>;

  /**
   * Reads one run. Rejects with `RunNotFoundError`.
   */
  describeRun(namespaceId: string, runId: string): Promise<RunDescription>;

  /**
   * Lists the namespace's runs, newest first. Rejects with
   * `InvalidCursorError`.
   */
  listRuns(namespaceId: string, input: ListRunsInput): Promise<RunPage>;

  /**
   * Reads a run's event history in sequence order. Rejects with
   * `RunNotFoundError`.
   */
  getHistory(namespaceId: string, runId: string): Promise<readonly HistoryEntry[]>;

  /**
   * Sends a signal. Rejects with `RunNotFoundError` or `RunNotOpenError`.
   */
  signalRun: (
    namespaceId: string,
    runId: string,
    signalName: string,
    payload?: unknown,
  ) => Promise<{ readonly sequenceNumber: number }>;

  /**
   * Requests graceful cancellation. Rejects with `RunNotFoundError` or
   * `RunAlreadyClosedError`.
   */
  cancelRun: (
    namespaceId: string,
    runId: string,
    reason?: string,
  ) => Promise<{ readonly requested: boolean; readonly sequenceNumber: number }>;

  /**
   * Terminates a run at once. Rejects with `RunNotFoundError` or
   * `RunAlreadyClosedError`.
   */
  terminateRun: (
    namespaceId: string,
    runId: string,
    reason?: string,
  ) => Promise<{ readonly sequenceNumber: number }>;
}

/**
 * Options for `createRunService`. `queueName` is the queue every workflow
 * task created by the service goes to.
 */
export interface RunServiceOptions {
  readonly queueName: string;
}

interface RunRow {
  id: string;
  workflow_type: string;
  status: string;
  input: unknown;
  result: unknown;
  error: { name: string; message: string } | null;
  started_at: Date;
  closed_at: Date | null;
  last_sequence_number: string;
  idempotency_key: string | null;
}

interface CursorRow extends RunRow {
  started_cursor: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_COLUMNS = `id, workflow_type, status, input, result, error, started_at, closed_at,
  last_sequence_number, idempotency_key`;

function toSummary(row: RunRow): RunSummary {
  return {
    runId: row.id,
    workflowType: row.workflow_type,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
  };
}

function toDescription(row: RunRow): RunDescription {
  return {
    ...toSummary(row),
    input: row.input,
    result: row.result,
    error: row.error,
    lastSequenceNumber: Number(row.last_sequence_number),
    idempotencyKey: row.idempotency_key,
  };
}

function encodeCursor(startedCursor: string, runId: string): string {
  return Buffer.from(`${startedCursor}|${runId}`).toString("base64url");
}

function decodeCursor(cursor: string): { startedCursor: string; runId: string } {
  const [startedCursor, runId, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  if (
    startedCursor === undefined ||
    runId === undefined ||
    rest.length > 0 ||
    !UUID_PATTERN.test(runId) ||
    Number.isNaN(Date.parse(startedCursor))
  ) {
    throw new InvalidCursorError();
  }
  return { startedCursor, runId };
}

/**
 * Creates a `RunService` over `pool`.
 */
export function createRunService(pool: Pool, options: RunServiceOptions): RunService {
  const store = createPostgresEventStore(pool);
  const interactions: RunInteractions = createRunInteractions(pool, {
    queueName: options.queueName,
    workflows: createWorkflowRegistry(),
    clock: systemClock,
    random: systemRandomSource,
  });
  const control: RunControl = createRunControl(pool, { queueName: options.queueName });

  async function assertOwned(namespaceId: string, runId: string): Promise<void> {
    if (!UUID_PATTERN.test(runId)) {
      throw new RunNotFoundError(runId);
    }
    const owned = await pool.query(
      "select 1 from workflow_runs where id = $1 and namespace_id = $2",
      [runId, namespaceId],
    );
    if (owned.rowCount !== 1) {
      throw new RunNotFoundError(runId);
    }
  }

  async function readRun(namespaceId: string, runId: string): Promise<RunRow> {
    if (!UUID_PATTERN.test(runId)) {
      throw new RunNotFoundError(runId);
    }
    const result = await pool.query<RunRow>(
      `select ${RUN_COLUMNS} from workflow_runs where id = $1 and namespace_id = $2`,
      [runId, namespaceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RunNotFoundError(runId);
    }
    return row;
  }

  async function insertRun(namespaceId: string, input: StartRunInput): Promise<string | undefined> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query<{ id: string }>(
        `insert into workflow_runs (namespace_id, workflow_type, input, idempotency_key)
         values ($1, $2, $3::jsonb, $4)
         on conflict (namespace_id, idempotency_key) where idempotency_key is not null
         do nothing
         returning id`,
        [
          namespaceId,
          input.workflowType,
          JSON.stringify(input.input ?? null),
          input.idempotencyKey ?? null,
        ],
      );
      const runId = inserted.rows[0]?.id;
      if (runId === undefined) {
        await client.query("rollback");
        return undefined;
      }
      await appendEventsOnClient(client, jsonCodec, runId, 0, [
        {
          type: "run_started",
          workflowType: input.workflowType,
          input: input.input ?? null,
        },
      ]);
      await client.query(
        `insert into tasks (namespace_id, run_id, queue_name, task_type, payload)
         values ($1, $2, $3, 'WORKFLOW_TASK', $4::jsonb)`,
        [namespaceId, runId, options.queueName, JSON.stringify({ reason: "start" })],
      );
      await client.query("commit");
      return runId;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async startRun(namespaceId: string, input: StartRunInput): Promise<StartRunResult> {
      const runId = await insertRun(namespaceId, input);
      if (runId !== undefined) {
        return { created: true, run: toDescription(await readRun(namespaceId, runId)) };
      }
      const existing = await pool.query<RunRow>(
        `select ${RUN_COLUMNS} from workflow_runs
         where namespace_id = $1 and idempotency_key = $2`,
        [namespaceId, input.idempotencyKey],
      );
      const row = existing.rows[0];
      if (row === undefined || input.idempotencyKey === undefined) {
        throw new Error("a start request was rejected as a duplicate but no run holds its key");
      }
      const sameRequest =
        row.workflow_type === input.workflowType &&
        isDeepStrictEqual(row.input, input.input ?? null);
      if (!sameRequest) {
        throw new IdempotencyConflictError(input.idempotencyKey, row.id);
      }
      return { created: false, run: toDescription(row) };
    },

    async describeRun(namespaceId: string, runId: string): Promise<RunDescription> {
      return toDescription(await readRun(namespaceId, runId));
    },

    async listRuns(namespaceId: string, input: ListRunsInput): Promise<RunPage> {
      const conditions = ["namespace_id = $1"];
      const values: unknown[] = [namespaceId];
      if (input.status !== undefined) {
        values.push(input.status);
        conditions.push(`status = $${String(values.length)}`);
      }
      if (input.workflowType !== undefined) {
        values.push(input.workflowType);
        conditions.push(`workflow_type = $${String(values.length)}`);
      }
      if (input.cursor !== undefined) {
        const { startedCursor, runId } = decodeCursor(input.cursor);
        values.push(startedCursor, runId);
        conditions.push(
          `(started_at, id) < ($${String(values.length - 1)}::timestamptz, $${String(values.length)}::uuid)`,
        );
      }
      values.push(input.limit + 1);
      const result = await pool.query<CursorRow>(
        `select ${RUN_COLUMNS},
           to_char(started_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started_cursor
         from workflow_runs
         where ${conditions.join(" and ")}
         order by started_at desc, id desc
         limit $${String(values.length)}`,
        values,
      );
      const page = result.rows.slice(0, input.limit);
      const last = page.at(-1);
      const hasMore = result.rows.length > input.limit;
      return {
        runs: page.map(toSummary),
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeCursor(last.started_cursor, last.id) }
          : {}),
      };
    },

    async getHistory(namespaceId: string, runId: string): Promise<readonly HistoryEntry[]> {
      await assertOwned(namespaceId, runId);
      const events = await store.read(runId);
      return events.map((stored) => ({
        sequenceNumber: stored.sequenceNumber,
        createdAt: stored.createdAt.toISOString(),
        event: stored.event,
      }));
    },

    async signalRun(namespaceId, runId, signalName, payload) {
      await assertOwned(namespaceId, runId);
      return interactions.signalRun(runId, signalName, payload);
    },

    async cancelRun(namespaceId, runId, reason) {
      await assertOwned(namespaceId, runId);
      return control.cancelRun(runId, reason);
    },

    async terminateRun(namespaceId, runId, reason) {
      await assertOwned(namespaceId, runId);
      return control.terminateRun(runId, reason);
    },
  };
}
