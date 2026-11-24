import { isDeepStrictEqual } from "node:util";
import {
  createDeadLetterQueue,
  noopTracing,
  type Tracing,
  RunNotFoundError,
  applyRunTimeoutsOnClient,
  insertRunStatement,
  createPostgresEventStore,
  type EventStore,
  createRunControl,
  createRunInteractions,
  createWorkflowRegistry,
  jsonCodec,
  type WorkflowRegistry,
  systemClock,
  systemRandomSource,
  type Pool,
  type RunConcurrencyState,
  type RunControl,
  type RunInteractions,
  type UpdateCallOptions,
  type UpdateOutcome,
  type UpdateWaitOptions,
  type WorkflowEvent,
  createEventService,
  rollbackQuietly,
  compileVisibilityQuery,
  validateMemo,
  readRunConcurrency,
  validatePriority,
  validateSearchAttributes,
  type SearchAttributes,
  type CreateEventTriggerInput,
  type EventTrigger,
  type SendEventInput,
  type SendEventReceipt,
  type SignalReceipt,
  type SignalWithStartReceipt,
  InvalidStartPolicyError,
  admitStartOnClient,
  liveIdempotencyKeyCondition,
  validateStartPolicies,
  type ClockSource,
  type DebounceStart,
  type PendingStart,
  type SingletonStart,
  type InsertedRunRow,
} from "@dee/core";
import { createOperations, type Operations, type PauseDescription } from "./operations.ts";

/**
 * What `RunService.signalWithStart` sends: the run to start when no run
 * holds `workflowKey` yet, and the signal.
 */
export interface SignalWithStartRequest {
  readonly workflowType: string;
  readonly workflowKey: string;
  readonly input?: unknown;
  readonly signalName: string;
  readonly payload?: unknown;
  readonly signalId?: string | undefined;
}

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
 * Raised when a dead letter does not exist in the caller's namespace or was
 * requeued already.
 */
export class DeadLetterNotFoundError extends Error {
  constructor(id: string) {
    super(`dead letter "${id}" was not found`);
    this.name = "DeadLetterNotFoundError";
  }
}

/**
 * Raised when a run is started for a workflow type the service's registry
 * does not know.
 */
export class UnknownWorkflowTypeError extends Error {
  readonly workflowType: string;

  constructor(workflowType: string) {
    super(`workflow type "${workflowType}" is not registered`);
    this.name = "UnknownWorkflowTypeError";
    this.workflowType = workflowType;
  }
}

/**
 * A step task that ran out of attempts, as the api shows it.
 */
export interface DeadLetterSummary {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempts: number;
  readonly error: { readonly name: string; readonly message: string };
  readonly reason: string;
  readonly createdAt: string;
}

/**
 * The namespace a caller is authenticated for.
 */
export interface NamespaceDescription {
  readonly id: string;
  readonly name: string;
}

/**
 * The events of a run after a sequence number, with the run's status at the
 * time of the read. `closed` is true once the run has left `RUNNING`.
 */
export interface HistorySlice {
  readonly events: readonly HistoryEntry[];
  readonly status: string;
  readonly closed: boolean;
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
  readonly searchAttributes: SearchAttributes;
  readonly memo: unknown;
}

/**
 * Everything the projection of a run knows. `describeRun` adds
 * `concurrency` for a run whose workflow has a concurrency key: the key, its
 * limit, how many runs hold one of its slots, whether this run holds one and
 * whether it has work waiting for one.
 */
export interface RunDescription extends RunSummary {
  readonly input: unknown;
  readonly result: unknown;
  readonly error: { readonly name: string; readonly message: string } | null;
  readonly lastSequenceNumber: number;
  readonly idempotencyKey: string | null;
  readonly concurrency?: RunConcurrencyState;
  /** The pauses that hold back the run's tasks, its own first. Absent when none does. */
  readonly paused?: readonly PauseDescription[];
}

/**
 * Input of `startRun`.
 */
export interface StartRunInput {
  readonly workflowType: string;
  readonly input?: unknown;
  readonly idempotencyKey?: string;
  readonly traceparent?: string;
  readonly runTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
  readonly searchAttributes?: SearchAttributes;
  readonly memo?: unknown;
  readonly priority?: number;
  /** How long `idempotencyKey` keeps mapping to the run it started. */
  readonly idempotencyTtlMs?: number;
  /** Folds the starts of one key in a window into one run (see `DebounceStart`). */
  readonly debounce?: DebounceStart;
  /** Allows one open run per key (see `SingletonStart`). */
  readonly singleton?: SingletonStart;
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
 * A start that was recorded but has not created its run yet: a debounced
 * start (`fireAt` is when its window closes) or a queued singleton start
 * (`fireAt` is null). `runId` is the id the run will get.
 */
export interface PendingStartDescription {
  readonly runId: string;
  readonly kind: "debounce" | "singleton";
  readonly key: string;
  readonly workflowType: string;
  readonly fireAt: string | null;
  readonly startCount: number;
}

/**
 * What `requestStart` returns for a start that creates its run later.
 */
export interface PendingStartResult {
  readonly created: false;
  readonly pending: PendingStartDescription;
}

/**
 * Filters and paging of `listRuns`.
 */
export interface ListRunsInput {
  readonly status?: string | undefined;
  readonly workflowType?: string | undefined;
  readonly startedAfter?: string | undefined;
  readonly startedBefore?: string | undefined;
  /** A visibility query (see `compileVisibilityQuery`), combined with the other filters. */
  readonly query?: string | undefined;
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
 * Paging of `getHistory` and `listDeadLetters`. `limit` defaults to
 * `DEFAULT_PAGE_LIMIT` and is capped at `MAX_PAGE_LIMIT`.
 */
export interface PageInput {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * One page of a run's history. `nextCursor` is absent on the last page.
 */
export interface HistoryPage {
  readonly events: readonly HistoryEntry[];
  readonly nextCursor?: string;
}

/**
 * One page of dead letters, oldest first. `nextCursor` is absent on the
 * last page.
 */
export interface DeadLetterPage {
  readonly deadLetters: readonly DeadLetterSummary[];
  readonly nextCursor?: string;
}

/**
 * The page size used when a request gives no `limit`.
 */
export const DEFAULT_PAGE_LIMIT = 500;

/**
 * The largest page a request can ask for.
 */
export const MAX_PAGE_LIMIT = 1000;

/**
 * One event of a run's history. `version` is the event format version it
 * was written with.
 */
export interface HistoryEntry {
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly version: number;
  readonly event: WorkflowEvent;
}

/**
 * The operations behind the endpoints. Every method takes the caller's
 * namespace id first and filters on it: a run of another namespace is
 * reported exactly like a run that does not exist.
 */
export interface RunService extends Operations {
  /**
   * Starts a run, or returns the run the same idempotency key started
   * before. Rejects with `IdempotencyConflictError` when the key was used
   * for a different request.
   */
  startRun(namespaceId: string, input: StartRunInput): Promise<StartRunResult>;

  /**
   * Like `startRun`, and also accepts the policies that create the run
   * later: a debounced start and a queued singleton start resolve a
   * `PendingStartResult`. Rejects with `SingletonRunOpenError` when a
   * refusing singleton start finds its key open, and with
   * `InvalidStartPolicyError` for malformed policies.
   */
  requestStart(
    namespaceId: string,
    input: StartRunInput,
  ): Promise<StartRunResult | PendingStartResult>;

  /**
   * Reads one run. Rejects with `RunNotFoundError`.
   */
  describeRun(namespaceId: string, runId: string): Promise<RunDescription>;

  /**
   * Lists the namespace's runs, newest first. Rejects with
   * `InvalidCursorError`, or `VisibilityQueryError` for a query that does not
   * parse.
   */
  listRuns(namespaceId: string, input: ListRunsInput): Promise<RunPage>;

  /**
   * Reads one page of a run's event history in sequence order. Follow
   * `nextCursor` for the rest. Rejects with `RunNotFoundError` or
   * `InvalidCursorError`.
   */
  getHistory(namespaceId: string, runId: string, page?: PageInput): Promise<HistoryPage>;

  /**
   * Reads the events of a run with a sequence number above `afterSequence`
   * together with the run's status. Rejects with `RunNotFoundError`.
   */
  readHistorySince(
    namespaceId: string,
    runId: string,
    afterSequence: number,
  ): Promise<HistorySlice>;

  /**
   * Reads the namespace the caller is authenticated for.
   */
  describeNamespace(namespaceId: string): Promise<NamespaceDescription>;

  /**
   * Lists one page of the namespace's dead letters that wait for an
   * operator, oldest first. Rejects with `InvalidCursorError`.
   */
  listDeadLetters(namespaceId: string, page?: PageInput): Promise<DeadLetterPage>;

  /**
   * Puts a dead letter's step task back on its queue with a fresh retry
   * budget and returns the new task id. Rejects with
   * `DeadLetterNotFoundError`.
   */
  requeueDeadLetter(
    namespaceId: string,
    deadLetterId: string,
  ): Promise<{ readonly taskId: string }>;

  /**
   * Sends a signal. Rejects with `RunNotFoundError` or `RunNotOpenError`.
   */
  signalRun: (
    namespaceId: string,
    runId: string,
    signalName: string,
    payload?: unknown,
    signalId?: string,
  ) => Promise<SignalReceipt>;

  /**
   * Signals the open run that holds `request.workflowKey`, starting it first
   * when no run holds the key. Rejects with `UnknownWorkflowTypeError`,
   * `RunNotOpenError` or `WorkflowKeyConflictError`.
   */
  signalWithStart: (
    namespaceId: string,
    request: SignalWithStartRequest,
  ) => Promise<SignalWithStartReceipt>;

  /**
   * Sends an external event to the runs waiting for its name and key and
   * starts the runs of its matching triggers.
   */
  sendEvent: (namespaceId: string, input: SendEventInput) => Promise<SendEventReceipt>;

  /**
   * Registers an event trigger. Rejects with `UnknownWorkflowTypeError`.
   */
  createEventTrigger: (
    namespaceId: string,
    input: CreateEventTriggerInput,
  ) => Promise<EventTrigger>;

  /**
   * Lists the namespace's event triggers, oldest first.
   */
  listEventTriggers: (namespaceId: string) => Promise<EventTrigger[]>;

  /**
   * Validates the update `updateName` against the run's current state,
   * records it and waits for its outcome. A rejected update writes nothing.
   * Rejects with `RunNotFoundError`, `RunNotOpenError`,
   * `RunHistoryCompactedError`, `WorkflowNotLoadedError`,
   * `UnknownUpdateError` or `UpdateRejectedError`.
   */
  updateRun: (
    namespaceId: string,
    runId: string,
    updateName: string,
    argument: unknown,
    options?: UpdateCallOptions,
  ) => Promise<UpdateOutcome>;

  /**
   * Answers the query `queryName` from the run's current state without
   * writing anything. Rejects with `RunNotFoundError`,
   * `RunHistoryCompactedError`, `WorkflowNotLoadedError` or
   * `UnknownQueryError`.
   */
  queryRun: (
    namespaceId: string,
    runId: string,
    queryName: string,
    argument?: unknown,
  ) => Promise<unknown>;

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
 * task created by the service goes to. With `workflows`, `startRun` rejects
 * a workflow type the registry does not know with `UnknownWorkflowTypeError`;
 * without it any type is accepted, because the process that serves the api
 * need not be the one that runs the workflows. Updates and queries replay
 * the workflow, so they need `workflows` and answer `WorkflowNotLoadedError`
 * without it. `updateWait` replaces the clock and timer an update waits
 * for its outcome with.
 */
export interface RunServiceOptions {
  readonly queueName: string;
  readonly tracing?: Tracing;
  readonly workflows?: WorkflowRegistry;
  readonly updateWait?: UpdateWaitOptions;
  /** "Now" for idempotency key expiry, debounce windows and read-your-writes (default the system clock). */
  readonly clock?: ClockSource;
  /**
   * A pool on a read replica. Run lists, run descriptions and histories are
   * read from it, except for a run this service started, signalled or
   * changed in the last `readYourWritesMs` (and the run list of its
   * namespace after a start), which are read from the primary. A run the
   * replica does not know yet is read from the primary.
   */
  readonly readPool?: Pool;
  /** How long after a write its run is read from the primary (default `DEFAULT_READ_YOUR_WRITES_MS`). */
  readonly readYourWritesMs?: number;
}

/**
 * How long after a start, signal or other write a run (and, after a start,
 * the run list of its namespace) is read from the primary instead of the
 * read replica.
 */
export const DEFAULT_READ_YOUR_WRITES_MS = 10_000;

const MAX_REMEMBERED_WRITES = 10_000;

interface Reader {
  readonly db: Pool;
  readonly events: EventStore;
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
  search_attributes: SearchAttributes;
  memo: unknown;
}

interface CursorRow extends RunRow {
  started_cursor: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_COLUMNS = `id, workflow_type, status, input, result, error, started_at, closed_at,
  last_sequence_number, idempotency_key, search_attributes, memo`;

function toSummary(row: RunRow): RunSummary {
  return {
    runId: row.id,
    workflowType: row.workflow_type,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    searchAttributes: row.search_attributes,
    memo: row.memo,
  };
}

function toPendingDescription(pending: PendingStart): PendingStartDescription {
  return {
    runId: pending.runId,
    kind: pending.kind,
    key: pending.key,
    workflowType: pending.workflowType,
    fireAt: pending.fireAt === null ? null : pending.fireAt.toISOString(),
    startCount: pending.startCount,
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

function pageSize(page: PageInput | undefined): number {
  return Math.min(Math.max(page?.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
}

function parseSequenceCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d{1,15}$/.test(cursor)) {
    throw new InvalidCursorError();
  }
  return Number(cursor);
}

function parseIdCursor(cursor: string | undefined): string | undefined {
  if (cursor !== undefined && !UUID_PATTERN.test(cursor)) {
    throw new InvalidCursorError();
  }
  return cursor;
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
  const tracing = options.tracing ?? noopTracing;
  const clock = options.clock ?? systemClock;
  const store = createPostgresEventStore(pool);
  const readPool = options.readPool;
  const readStore = readPool === undefined ? store : createPostgresEventStore(readPool);
  const readYourWritesMs = options.readYourWritesMs ?? DEFAULT_READ_YOUR_WRITES_MS;
  const recentWrites = new Map<string, number>();

  function remember(...keys: readonly string[]): void {
    if (readPool === undefined) {
      return;
    }
    const until = clock.now().getTime() + readYourWritesMs;
    for (const key of keys) {
      recentWrites.delete(key);
      recentWrites.set(key, until);
    }
    for (const oldest of recentWrites.keys()) {
      if (recentWrites.size <= MAX_REMEMBERED_WRITES) {
        break;
      }
      recentWrites.delete(oldest);
    }
  }

  function writtenRecently(key: string): boolean {
    const until = recentWrites.get(key);
    if (until === undefined) {
      return false;
    }
    if (until <= clock.now().getTime()) {
      recentWrites.delete(key);
      return false;
    }
    return true;
  }

  const primaryReader: Reader = { db: pool, events: store };

  async function readThrough<T>(
    key: string,
    read: (reader: Reader) => Promise<T | undefined>,
    missing: () => Error,
  ): Promise<T> {
    if (readPool !== undefined && !writtenRecently(key)) {
      const fromReplica = await read({ db: readPool, events: readStore });
      if (fromReplica !== undefined) {
        return fromReplica;
      }
    }
    const fromPrimary = await read(primaryReader);
    if (fromPrimary === undefined) {
      throw missing();
    }
    return fromPrimary;
  }

  function runKey(runId: string): string {
    return `run:${runId}`;
  }

  function namespaceKey(namespaceId: string): string {
    return `namespace:${namespaceId}`;
  }
  const interactions: RunInteractions = createRunInteractions(pool, {
    workflows: options.workflows ?? createWorkflowRegistry(),
    clock: systemClock,
    random: systemRandomSource,
    ...(options.updateWait === undefined ? {} : { updateWait: options.updateWait }),
  });
  const control: RunControl = createRunControl(pool);
  const events = createEventService(pool);

  function assertKnownType(workflowType: string): void {
    if (options.workflows !== undefined && options.workflows.get(workflowType) === undefined) {
      throw new UnknownWorkflowTypeError(workflowType);
    }
  }
  const deadLetters = createDeadLetterQueue(pool);
  const operations = createOperations(pool, { queueName: options.queueName, clock });

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

  async function findRun(
    db: Pool,
    namespaceId: string,
    runId: string,
  ): Promise<RunRow | undefined> {
    if (!UUID_PATTERN.test(runId)) {
      return undefined;
    }
    const result = await db.query<RunRow>(
      `select ${RUN_COLUMNS} from workflow_runs where id = $1 and namespace_id = $2`,
      [runId, namespaceId],
    );
    return result.rows[0];
  }

  async function readRun(namespaceId: string, runId: string): Promise<RunRow> {
    const row = await findRun(pool, namespaceId, runId);
    if (row === undefined) {
      throw new RunNotFoundError(runId);
    }
    return row;
  }

  async function findByKey(
    namespaceId: string,
    input: StartRunInput,
    now: Date,
  ): Promise<StartRunResult | undefined> {
    if (input.idempotencyKey === undefined) {
      return undefined;
    }
    const existing = await pool.query<RunRow>(
      `select ${RUN_COLUMNS} from workflow_runs
       where namespace_id = $1 and idempotency_key = $2 and ${liveIdempotencyKeyCondition(3)}`,
      [namespaceId, input.idempotencyKey, now],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const sameRequest =
      row.workflow_type === input.workflowType && isDeepStrictEqual(row.input, input.input ?? null);
    if (!sameRequest) {
      throw new IdempotencyConflictError(input.idempotencyKey, row.id);
    }
    return { created: false, run: toDescription(row) };
  }

  function isPlainStart(input: StartRunInput): boolean {
    return (
      input.idempotencyKey === undefined &&
      input.debounce === undefined &&
      input.singleton === undefined &&
      input.runTimeoutMs === undefined &&
      input.executionTimeoutMs === undefined
    );
  }

  async function insertRun(
    namespaceId: string,
    input: StartRunInput,
    now: Date,
  ): Promise<{ readonly runId: string } | { readonly pending: PendingStart } | undefined> {
    const searchAttributes =
      input.searchAttributes === undefined ? {} : validateSearchAttributes(input.searchAttributes);
    const memo = input.memo === undefined ? undefined : validateMemo(input.memo);
    const priority = validatePriority(input.priority);
    const span = tracing.startSpan("workflow.start", {
      parent: input.traceparent,
      kind: "server",
      attributes: { "dee.workflow.type": input.workflowType, "dee.namespace.id": namespaceId },
    });
    const statementFor = (singletonKey: string | undefined): [string, unknown[]] =>
      insertRunStatement(jsonCodec, {
        namespaceId,
        workflowType: input.workflowType,
        input: input.input ?? null,
        queueName: options.queueName,
        idempotencyKey: input.idempotencyKey,
        searchAttributes,
        memo,
        priority,
        traceparent: span.traceparent ?? null,
        singletonKey,
        idempotencyExpiresAt:
          input.idempotencyTtlMs === undefined
            ? undefined
            : new Date(now.getTime() + input.idempotencyTtlMs),
      });
    if (isPlainStart(input)) {
      try {
        const inserted = await pool.query<InsertedRunRow>(...statementFor(undefined));
        const runId = inserted.rows[0]?.id ?? "";
        span.setAttributes({ "dee.run.id": runId });
        span.end();
        return { runId };
      } catch (error) {
        span.recordError(error);
        span.end();
        throw error;
      }
    }
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      const admission = await admitStartOnClient(
        client,
        {
          namespaceId,
          workflowType: input.workflowType,
          input: input.input ?? null,
          queueName: options.queueName,
          options: {
            runTimeoutMs: input.runTimeoutMs,
            executionTimeoutMs: input.executionTimeoutMs,
            searchAttributes: input.searchAttributes,
            memo: input.memo,
            priority: input.priority,
          },
        },
        input,
        now,
      );
      if (admission.kind === "pending") {
        await client.query("commit");
        span.setAttributes({ "dee.start.pending": admission.pending.kind });
        span.end();
        return { pending: admission.pending };
      }
      const inserted = await client.query<InsertedRunRow>(...statementFor(admission.singletonKey));
      const runId = inserted.rows[0]?.id;
      if (runId === undefined) {
        await client.query("rollback");
        span.setAttributes({ "dee.start.duplicate": true });
        span.end();
        return undefined;
      }
      await applyRunTimeoutsOnClient(client, runId, now, {
        runTimeoutMs: input.runTimeoutMs,
        executionTimeoutMs: input.executionTimeoutMs,
      });
      await client.query("commit");
      span.setAttributes({ "dee.run.id": runId });
      span.end();
      return { runId };
    } catch (error) {
      broken = !(await rollbackQuietly(client));
      span.recordError(error);
      span.end();
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async function requestStart(
    namespaceId: string,
    input: StartRunInput,
  ): Promise<StartRunResult | PendingStartResult> {
    if (
      options.workflows !== undefined &&
      options.workflows.get(input.workflowType) === undefined
    ) {
      throw new UnknownWorkflowTypeError(input.workflowType);
    }
    validateStartPolicies(input);
    const now = clock.now();
    const earlier = await findByKey(namespaceId, input, now);
    if (earlier !== undefined) {
      return earlier;
    }
    const inserted = await insertRun(namespaceId, input, now);
    if (inserted !== undefined && "pending" in inserted) {
      return { created: false, pending: toPendingDescription(inserted.pending) };
    }
    if (inserted !== undefined) {
      remember(runKey(inserted.runId), namespaceKey(namespaceId));
      return { created: true, run: toDescription(await readRun(namespaceId, inserted.runId)) };
    }
    const raced = await findByKey(namespaceId, input, now);
    if (raced === undefined) {
      throw new Error("a start request was rejected as a duplicate but no run holds its key");
    }
    return raced;
  }

  return {
    ...operations,

    async startRun(namespaceId: string, input: StartRunInput): Promise<StartRunResult> {
      if (input.debounce !== undefined || input.singleton?.whenOpen === "queue") {
        throw new InvalidStartPolicyError(
          "startRun creates its run at once; a debounced or queued start goes through requestStart",
        );
      }
      const result = await requestStart(namespaceId, input);
      if ("pending" in result) {
        throw new Error("startRun recorded a pending start");
      }
      return result;
    },

    requestStart,

    async describeRun(namespaceId: string, runId: string): Promise<RunDescription> {
      const { description, concurrency } = await readThrough(
        runKey(runId),
        async ({ db }) => {
          const row = await findRun(db, namespaceId, runId);
          return row === undefined
            ? undefined
            : { description: toDescription(row), concurrency: await readRunConcurrency(db, runId) };
        },
        () => new RunNotFoundError(runId),
      );
      const paused = await operations.pausesOfRun(namespaceId, runId);
      return {
        ...description,
        ...(concurrency === undefined ? {} : { concurrency }),
        ...(paused.length === 0 ? {} : { paused }),
      };
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
      if (input.startedAfter !== undefined) {
        values.push(input.startedAfter);
        conditions.push(`started_at >= $${String(values.length)}::timestamptz`);
      }
      if (input.startedBefore !== undefined) {
        values.push(input.startedBefore);
        conditions.push(`started_at < $${String(values.length)}::timestamptz`);
      }
      if (input.query !== undefined && input.query.trim().length > 0) {
        const compiled = compileVisibilityQuery(input.query, values.length + 1);
        values.push(...compiled.values);
        conditions.push(compiled.sql);
      }
      if (input.cursor !== undefined) {
        const { startedCursor, runId } = decodeCursor(input.cursor);
        values.push(startedCursor, runId);
        conditions.push(
          `(started_at, id) < ($${String(values.length - 1)}::timestamptz, $${String(values.length)}::uuid)`,
        );
      }
      values.push(input.limit + 1);
      const lister =
        readPool === undefined || writtenRecently(namespaceKey(namespaceId)) ? pool : readPool;
      const result = await lister.query<CursorRow>(
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

    async getHistory(namespaceId, runId, page) {
      const after = parseSequenceCursor(page?.cursor);
      const limit = pageSize(page);
      const events = await readThrough(
        runKey(runId),
        async ({ db, events: reader }) =>
          (await findRun(db, namespaceId, runId)) === undefined
            ? undefined
            : reader.read(runId, after, limit + 1),
        () => new RunNotFoundError(runId),
      );
      const shown = events.slice(0, limit);
      const last = shown.at(-1);
      return {
        events: shown.map((stored) => ({
          sequenceNumber: stored.sequenceNumber,
          createdAt: stored.createdAt.toISOString(),
          version: stored.version,
          event: stored.event,
        })),
        ...(events.length > limit && last !== undefined
          ? { nextCursor: String(last.sequenceNumber) }
          : {}),
      };
    },

    async readHistorySince(namespaceId, runId, afterSequence) {
      const { run, events } = await readThrough(
        runKey(runId),
        async ({ db, events: reader }) => {
          const found = await findRun(db, namespaceId, runId);
          return found === undefined
            ? undefined
            : { run: found, events: await reader.read(runId, afterSequence) };
        },
        () => new RunNotFoundError(runId),
      );
      return {
        events: events.map((stored) => ({
          sequenceNumber: stored.sequenceNumber,
          createdAt: stored.createdAt.toISOString(),
          version: stored.version,
          event: stored.event,
        })),
        status: run.status,
        closed: run.status !== "RUNNING",
      };
    },

    async describeNamespace(namespaceId) {
      const result = await pool.query<{ id: string; name: string }>(
        "select id, name from namespaces where id = $1",
        [namespaceId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`namespace "${namespaceId}" does not exist`);
      }
      return { id: row.id, name: row.name };
    },

    async listDeadLetters(namespaceId, page) {
      const afterId = parseIdCursor(page?.cursor);
      const limit = pageSize(page);
      const letters = await deadLetters.list({
        namespaceId,
        limit: limit + 1,
        ...(afterId === undefined ? {} : { afterId }),
      });
      const shown = letters.slice(0, limit);
      const last = shown.at(-1);
      return {
        deadLetters: shown.map((letter) => ({
          id: letter.id,
          runId: letter.runId,
          stepId: letter.stepId,
          attempts: letter.attempts,
          error: { name: letter.error.name, message: letter.error.message },
          reason: letter.reason,
          createdAt: letter.createdAt.toISOString(),
        })),
        ...(letters.length > limit && last !== undefined ? { nextCursor: last.id } : {}),
      };
    },

    async requeueDeadLetter(namespaceId, deadLetterId) {
      if (!UUID_PATTERN.test(deadLetterId)) {
        throw new DeadLetterNotFoundError(deadLetterId);
      }
      const letter = await deadLetters.get(deadLetterId);
      if (letter?.namespaceId !== namespaceId || letter.requeuedAt !== null) {
        throw new DeadLetterNotFoundError(deadLetterId);
      }
      const taskId = await deadLetters.requeue(deadLetterId);
      if (taskId === undefined) {
        throw new DeadLetterNotFoundError(deadLetterId);
      }
      return { taskId };
    },

    async signalRun(namespaceId, runId, signalName, payload, signalId) {
      await assertOwned(namespaceId, runId);
      const receipt = await interactions.signalRun(runId, signalName, payload, { signalId });
      remember(runKey(runId));
      return receipt;
    },

    async signalWithStart(namespaceId, request) {
      assertKnownType(request.workflowType);
      const receipt = await interactions.signalWithStart({
        namespaceId,
        workflowType: request.workflowType,
        workflowKey: request.workflowKey,
        input: request.input ?? null,
        queueName: options.queueName,
        signalName: request.signalName,
        payload: request.payload ?? null,
        signalId: request.signalId,
      });
      remember(runKey(receipt.runId), namespaceKey(namespaceId));
      return receipt;
    },

    async sendEvent(namespaceId, input) {
      return events.sendEvent(namespaceId, input);
    },

    async createEventTrigger(namespaceId, input) {
      assertKnownType(input.workflowType);
      return events.createTrigger(namespaceId, {
        ...input,
        queueName: input.queueName ?? options.queueName,
      });
    },

    async listEventTriggers(namespaceId) {
      return events.listTriggers(namespaceId);
    },

    async updateRun(namespaceId, runId, updateName, argument, updateOptions) {
      await assertOwned(namespaceId, runId);
      remember(runKey(runId));
      return interactions.updateRun(runId, updateName, argument, updateOptions);
    },

    async queryRun(namespaceId, runId, queryName, argument) {
      await assertOwned(namespaceId, runId);
      return interactions.queryRun(runId, queryName, argument);
    },

    async cancelRun(namespaceId, runId, reason) {
      await assertOwned(namespaceId, runId);
      remember(runKey(runId));
      return control.cancelRun(runId, reason);
    },

    async terminateRun(namespaceId, runId, reason) {
      await assertOwned(namespaceId, runId);
      remember(runKey(runId));
      return control.terminateRun(runId, reason);
    },
  };
}
