# Tracing

Every run is one OpenTelemetry trace. The trace crosses the API, the workers, the timer scheduler, the schedule manager and child workflows, because the trace context travels with the run in the database and not in a process.

## How the context travels

`workflow_runs.traceparent` holds a W3C `traceparent` value. It is written when the run is created and read by everything that later emits a span for the run.

| Run created by          | Span that owns the context   | Parent of that span                                  |
| ----------------------- | ---------------------------- | ---------------------------------------------------- |
| `POST /v1/runs`         | `workflow.start`             | the request's `traceparent` header, when it is valid |
| a schedule trigger      | `workflow.schedule`          | none (a new trace)                                   |
| a `child_started` event | `workflow.child`             | the parent run's context                             |
| `ctx.continueAsNew`     | none (the context is copied) | the same trace as the previous run                   |

Every later span of a run hangs under the run's stored context.

## Spans

| Span                | Emitted by          | When                                                  |
| ------------------- | ------------------- | ----------------------------------------------------- |
| `workflow.start`    | API run service     | after the start transaction commits                   |
| `workflow.schedule` | schedule manager    | after the trigger transaction commits                 |
| `workflow.child`    | result recorder     | after the transaction that created the child commits  |
| `workflow.task`     | result recorder     | after a workflow task's decision was recorded         |
| `step <type>`       | step task processor | around each executed attempt, with `dee.step.attempt` |
| `timer <id>`        | timer scheduler     | when the timer fires, from its creation to the firing |

A span is started inside a transaction only when its context has to be stored in that transaction. It is ended after the commit. A transaction that rolls back never ends it, so it is never exported.

## No spans for replay

Replay runs the workflow code against recorded events and never executes a step body. Nothing in the decision loop emits a span. A `step` span exists only for an attempt that really ran. A workflow task delivered twice, or a step task whose result is already recorded, emits nothing the second time.

## Sampling

`createTracingProvider({ serviceName, otlpEndpoint, samplingRatio })` samples a share `samplingRatio` of new traces (default 1). The decision is made once, for the first span of the trace, and is stored in the flags of the `traceparent`. Every later span, in every process, follows that flag, so a run is either fully traced or not traced at all. A request that arrives with a `traceparent` header keeps the caller's decision.

## Using it

```ts
const provider = createTracingProvider({
  serviceName: "dee-api",
  otlpEndpoint: "http://localhost:4318/v1/traces",
  samplingRatio: 0.1,
});
const api = createApiServer(pool, { queueName: "default", tracing: provider.tracing });
```

Pass `provider.tracing` as the `tracing` option of `createResultRecorder`, `createStepTaskProcessor`, `createTimerScheduler` and `createScheduleManager` in the process that runs them. Without the option nothing is emitted and a run is stored without a context. Call `provider.shutdown()` before the process exits so the last spans are exported.

## Looking at a trace

`docker compose up -d jaeger` starts Jaeger with OTLP over HTTP on port 4318 and the UI on `http://localhost:16686`. Search for the service name, open a trace and the root is `workflow.start`.
