/**
 * The package name as declared in `package.json`, used by workspace
 * resolution tests to confirm this package is wired up correctly.
 */
export const packageName = "@dee/core";

export type { Codec } from "./event-store/codec.ts";
export {
  createGzipCodec,
  createSizeLimitedCodec,
  DEFAULT_MAX_PAYLOAD_BYTES,
  jsonCodec,
  maskSensitiveFields,
} from "./event-store/codec.ts";
export { appendEventsOnClient, createPostgresEventStore } from "./event-store/event-store.ts";
export type { EventStore, StoredEvent } from "./event-store/event-store.ts";
export { ConcurrencyError, PayloadTooLargeError } from "./event-store/errors.ts";
export {
  CURRENT_EVENT_VERSION,
  currentEventReader,
  KNOWN_EVENT_TYPES,
  readVersionedEvent,
  UnsupportedEventError,
} from "./event-store/event-version.ts";
export type { EventReader } from "./event-store/event-version.ts";
export {
  createHistoryExport,
  HISTORY_EXPORT_FORMAT,
  HISTORY_EXPORT_FORMAT_VERSION,
  InvalidHistoryExportError,
  parseHistoryExport,
} from "./replay/history-export.ts";
export type {
  ExportedEvent,
  HistoryExport,
  HistoryExportInputEvent,
  ParsedHistory,
} from "./replay/history-export.ts";
export { formatReplayResult, replayHistories } from "./replay/replay-histories.ts";
export type {
  HistoryReplayResult,
  HistoryToReplay,
  ReplayableWorkflow,
  ReplayHistoriesOptions,
  ReplayProblem,
  ReplayProblemKind,
  ReplayReport,
} from "./replay/replay-histories.ts";
export {
  runCompletedEventSchema,
  runCancelledEventSchema,
  runFailedEventSchema,
  runStartedEventSchema,
  runTerminatedEventSchema,
  runTimedOutEventSchema,
  stepCompletedEventSchema,
  stepFailedEventSchema,
  stepScheduledEventSchema,
  timerFiredEventSchema,
  timerStartedEventSchema,
  updateAcceptedEventSchema,
  updateCompletedEventSchema,
  workflowEventSchema,
} from "./event-store/events.ts";
export type { WorkflowEvent } from "./event-store/events.ts";

export type {
  CompleteUpdateCommand,
  CompleteRunCommand,
  FailRunCommand,
  ScheduleStepCommand,
  StartTimerCommand,
  WorkflowCommand,
} from "./workflow/commands.ts";
export type { WorkflowContext, WorkflowHandler } from "./workflow/context.ts";
export { runDecisionLoop } from "./workflow/decision-loop.ts";
export type { DecisionLoopOptions, DecisionResult } from "./workflow/decision-loop.ts";
export { InvalidTransitionError } from "./run/errors.ts";
export {
  assertRunAcceptsCommand,
  assertTransition,
  isTerminalState,
  RUN_STATES,
  RUN_STATE_TRANSITIONS,
} from "./run/state-machine.ts";
export type { RunState } from "./run/state-machine.ts";
export {
  applyEventToProjection,
  createInitialProjection,
  foldRunEvents,
} from "./run/projection.ts";
export type { RunProjection } from "./run/projection.ts";
export { rebuildProjection, refreshProjection } from "./run/projection-store.ts";
export { defineStep } from "./workflow/define-step.ts";
export type { DefineStepOptions, StepDefinition } from "./workflow/define-step.ts";
export { defineWorkflow } from "./workflow/define-workflow.ts";
export { deserializeError, serializeError } from "./workflow/error-serialization.ts";
export type { SerializedError } from "./workflow/error-serialization.ts";
export {
  CancelledError,
  InvalidSleepDurationError,
  NonDeterminismError,
  StepFailedError,
  VersionMismatchError,
} from "./workflow/errors.ts";
export {
  EXECUTION_TIMEOUT_TIMER_ID,
  RUN_TIMEOUT_TIMER_ID,
  applyRunTimeoutsOnClient,
  timeOutRunOnClient,
  validateTimeoutMs,
} from "./timeouts/run-timeouts.ts";
export { RunHistoryCompactedError } from "./signals/signal-service.ts";
export { ForbiddenApiError } from "./workflow/sandbox.ts";
export { runRegisteredWorkflowInMemory, runWorkflowInMemory } from "./workflow/run-workflow.ts";
export type { RunWorkflowOptions, RunWorkflowResult } from "./workflow/run-workflow.ts";
export { systemClock, systemRandomSource } from "./workflow/sources.ts";
export type { ClockSource, RandomSource } from "./workflow/sources.ts";
export { createStepRegistry } from "./workflow/step-registry.ts";
export type { StepContext, StepHandler, StepRegistry } from "./workflow/step-registry.ts";
export { createWorkflowRegistry } from "./workflow/workflow-registry.ts";
export type { WorkflowDefinition, WorkflowRegistry } from "./workflow/workflow-registry.ts";
export { TASK_TYPES, createTaskQueue, taskQueueName } from "./queue/task-queue.ts";
export type {
  DequeueOptions,
  EnqueueInput,
  LeasedTask,
  TaskQueue,
  TaskType,
} from "./queue/task-queue.ts";
export { createResultRecorder } from "./idempotency/recorder.ts";
export type {
  RecordStepResultInput,
  RecordWorkflowTaskResultInput,
  RecordedStepResult,
  RecordedWorkflowTaskResult,
  ResultRecorder,
  StepOutcome,
} from "./idempotency/recorder.ts";
export { createPool, DEFAULT_ACQUIRE_TIMEOUT_MS } from "./db/pool.ts";
export { rollbackQuietly, withClient, withTransaction } from "./db/transaction.ts";
export { enqueueStepTaskOnClient } from "./queue/step-task-enqueue.ts";
export type { StepTaskEnqueueInput } from "./queue/step-task-enqueue.ts";
export type { CreatePoolOptions } from "./db/pool.ts";
export {
  DEFAULT_POISON_THRESHOLD,
  MAX_RECOVERY_BACKOFF_MS,
  createJanitor,
} from "./recovery/janitor.ts";
export type {
  Janitor,
  JanitorOptions,
  QuarantinedTask,
  ReclaimedTask,
  RecoverStalledRunsOptions,
  StalledRun,
  StalledRunOptions,
  SweepReport,
} from "./recovery/janitor.ts";
export { markRunWaiting } from "./recovery/run-waiting.ts";
export type { RunWaitingMark, WaitingOn } from "./recovery/run-waiting.ts";
export { createRecoveryMetrics } from "./recovery/metrics.ts";
export type { RecoveryMetrics, RecoveryMetricsSnapshot } from "./recovery/metrics.ts";
export { resolveDatabaseUrl } from "./db/env.ts";
export type { DatabaseUrlEnv } from "./db/env.ts";
export type { Pool, PoolClient } from "pg";
export {
  DEFAULT_RETRY_POLICY,
  NonRetryableError,
  computeBackoffMs,
  decideRetry,
  isNonRetryable,
  resolveRetryPolicy,
} from "./retry/retry-policy.ts";
export type { GiveUpReason, RetryDecision, RetryPolicy } from "./retry/retry-policy.ts";
export {
  StepTimeoutError,
  enforceWorkflowTimeout,
  runWithTimeout,
  workflowDeadline,
} from "./retry/timeout.ts";
export type { TimeoutTimers, WorkflowTimeoutOutcome } from "./retry/timeout.ts";
export { createAttemptLog } from "./retry/attempt-log.ts";
export type { AttemptLog, RecordAttemptFailureInput } from "./retry/attempt-log.ts";
export { createDeadLetterQueue } from "./retry/dead-letters.ts";
export type {
  AddDeadLetterInput,
  DeadLetter,
  DeadLetterQueue,
  DeadLetterReason,
  ListDeadLettersOptions,
} from "./retry/dead-letters.ts";
export { createStepTaskProcessor } from "./retry/step-task-processor.ts";
export type {
  StepTaskOutcome,
  StepTaskPayload,
  StepTaskProcessor,
  StepTaskProcessorOptions,
} from "./retry/step-task-processor.ts";
export { createMonotonicClock } from "./timers/monotonic-clock.ts";
export type { MonotonicClock } from "./timers/monotonic-clock.ts";
export { createTimerScheduler, insertTimerOnClient } from "./timers/timer-scheduler.ts";
export type {
  CatchUpReport,
  FiredTimer,
  ScheduleTimerInput,
  TickReport,
  TimerScheduler,
  TimerSchedulerOptions,
} from "./timers/timer-scheduler.ts";
export {
  InvalidScheduleError,
  cronTimesBetween,
  nextCronTime,
  parseCron,
} from "./schedules/cron.ts";
export type { CronSchedule } from "./schedules/cron.ts";
export {
  ScheduleAlreadyExistsError,
  ScheduleNotFoundError,
  createScheduleManager,
} from "./schedules/schedule-manager.ts";
export type {
  CreateScheduleInput,
  CatchUpPolicy,
  OverlapPolicy,
  ScheduleManager,
  ScheduleManagerOptions,
  ScheduleRecord,
  ScheduleTickReport,
  ScheduleTrigger,
  TriggerOutcome,
} from "./schedules/schedule-manager.ts";
export { UnknownQueryError, runQuery } from "./workflow/query.ts";
export { UnknownUpdateError, UpdateRejectedError, defineUpdate } from "./workflow/define-update.ts";
export type {
  UpdateDefinition,
  UpdateHandler,
  UpdateSpec,
  UpdateValidator,
} from "./workflow/define-update.ts";
export {
  DEFAULT_UPDATE_WAIT_MS,
  MAX_UPDATE_WAIT_MS,
  WorkflowNotLoadedError,
  acceptUpdateOnClient,
  awaitUpdateOutcome,
  updateWaitMs,
} from "./signals/update-service.ts";
export type {
  UpdateAcceptOptions,
  UpdateCallOptions,
  UpdateOutcome,
  UpdateReceipt,
  UpdateWaitOptions,
} from "./signals/update-service.ts";
export { replayHistory } from "./workflow/decision-loop.ts";
export type { ReplayOutcome } from "./workflow/decision-loop.ts";
export type { CompensationHandler, QueryHandler, SelectResult } from "./workflow/context.ts";
export {
  RunNotFoundError,
  RunNotOpenError,
  createRunInteractions,
} from "./signals/signal-service.ts";
export type {
  RunInteractions,
  RunInteractionsOptions,
  SignalReceipt,
} from "./signals/signal-service.ts";
export { RunAlreadyClosedError, createRunControl } from "./cancellation/run-control.ts";
export type {
  CancelReceipt,
  RunControl,
  RunControlOptions,
  TerminateReceipt,
} from "./cancellation/run-control.ts";
export { closeRunIfTerminal } from "./cancellation/close-run.ts";
export { commandToEvent } from "./workflow/command-events.ts";
export { DEFAULT_MAX_CHILDREN } from "./workflow/decision-loop.ts";
export { ChildLimitExceededError } from "./workflow/errors.ts";
export type {
  ChildHandle,
  ChildOptions,
  ParallelOptions,
  ParallelTask,
} from "./workflow/context.ts";
export type { StartChildCommand } from "./workflow/commands.ts";
export {
  childCompletedEventSchema,
  childFailedEventSchema,
  childStartedEventSchema,
  parentClosePolicySchema,
} from "./event-store/events.ts";
export type { ParentClosePolicy } from "./event-store/events.ts";
export type { ResultRecorderOptions } from "./idempotency/recorder.ts";
export { createChildRunOnClient } from "./children/child-runs.ts";
export { lockRunWithParent } from "./children/run-locks.ts";
export type { LockedRun } from "./children/run-locks.ts";
export { requestCancellationOnClient } from "./cancellation/request-cancellation.ts";

export { createContinuedRunOnClient } from "./continuation/continued-run.ts";
export { findCurrentRun, readRunChain } from "./continuation/run-chain.ts";
export type { ChainRun } from "./continuation/run-chain.ts";
export { createHistoryCompactor } from "./compaction/history-compactor.ts";
export type {
  CompactionReport,
  CompactionResult,
  HistoryCompactor,
  HistoryCompactorOptions,
  RetentionPolicy,
} from "./compaction/history-compactor.ts";
export { readSnapshotOnClient } from "./compaction/snapshot.ts";
export type { RunSnapshot } from "./compaction/snapshot.ts";
export type { HistoryWarning } from "./workflow/decision-loop.ts";
export { createLiveSession } from "./workflow/live-session.ts";
export type { LiveAdvance, LiveSession } from "./workflow/live-session.ts";
export { createRunCache } from "./sticky/run-cache.ts";
export type { RunCache, RunCacheOptions, RunCacheStats } from "./sticky/run-cache.ts";
export { createStickyDecider } from "./sticky/sticky-decider.ts";
export type {
  DecisionSource,
  StickyDecider,
  StickyDeciderOptions,
  StickyDeciderStats,
  StickyDecision,
} from "./sticky/sticky-decider.ts";
export { createStickyRouter } from "./sticky/sticky-router.ts";
export type { StickyClaim, StickyRouter } from "./sticky/sticky-router.ts";

export { createRateLimiter } from "./quota/token-bucket.ts";
export type { RateLimitDecision, RateLimiter, TokenBucketConfig } from "./quota/token-bucket.ts";
export { UNLIMITED_QUOTA, createQuotaStore } from "./quota/quota-store.ts";
export type { NamespaceQuota, NamespaceUsage, QuotaStore } from "./quota/quota-store.ts";

export {
  createTracing,
  formatTraceparent,
  noopTracing,
  parseTraceparent,
} from "./observability/tracing.ts";
export type {
  ParsedTraceparent,
  StartSpanOptions,
  TraceSpan,
  Tracing,
} from "./observability/tracing.ts";
export { createTracingProvider } from "./observability/provider.ts";
export type { TracingProvider, TracingProviderOptions } from "./observability/provider.ts";

export { METRICS_CONTENT_TYPE, createMetricsRegistry } from "./observability/metrics-registry.ts";
export type {
  Counter,
  Gauge,
  Histogram,
  Labels,
  MetricDefinition,
  MetricsRegistry,
} from "./observability/metrics-registry.ts";
export {
  ENGINE_METRIC_NAMES,
  TASK_LATENCY_BUCKETS,
  createEngineMetrics,
} from "./observability/engine-metrics.ts";
export type {
  EngineMetrics,
  EngineMetricsOptions,
  TaskOutcome,
} from "./observability/engine-metrics.ts";
export {
  createLogger,
  currentCorrelationId,
  resolveCorrelationId,
  silentLogger,
  withCorrelationId,
} from "./observability/logger.ts";
export type { LogFields, LogLevel, Logger, LoggerOptions } from "./observability/logger.ts";
export { createHealthChecks } from "./observability/health.ts";
export type { HealthChecks, HealthChecksOptions, ReadinessResult } from "./observability/health.ts";
export { INVARIANT_NAMES, createInvariantChecker } from "./invariants/invariant-checker.ts";
export type {
  InvariantCheckOptions,
  InvariantChecker,
  InvariantName,
  InvariantReport,
  InvariantViolation,
} from "./invariants/invariant-checker.ts";
export {
  defaultMigrationsDir,
  loadMigrations,
  migrateDown,
  migrateUp,
  pendingMigrations,
} from "./db/migrator.ts";
export type { MigrateOptions, Migration } from "./db/migrator.ts";
export {
  DEFAULT_EMBEDDED_NAMESPACE,
  DEFAULT_EMBEDDED_QUEUE,
  IdempotencyKeyConflictError,
  NoOpenTransactionError,
  cancelWorkflow,
  signalWorkflow,
  startWorkflow,
} from "./embedded/transactional.ts";
export type {
  CancelWorkflowInput,
  EmbeddedOptions,
  SignalWorkflowInput,
  StartWorkflowInput,
  StartWorkflowResult,
} from "./embedded/transactional.ts";

export type { DemoContext, DemoReport, DemoRunClient, DemoRunSnapshot } from "./demo/demo-types.ts";
