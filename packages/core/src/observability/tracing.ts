import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/**
 * The parts of a W3C `traceparent` header value this engine carries between
 * processes.
 */
export interface ParsedTraceparent {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

/**
 * Parses a W3C `traceparent` value (`00-<trace id>-<span id>-<flags>`).
 * Returns `undefined` for anything that is not a valid version 00 value,
 * including all-zero ids.
 */
export function parseTraceparent(value: string | null | undefined): ParsedTraceparent | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const [, traceId = "", spanId = "", flags = "00"] = match;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return undefined;
  }
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & TraceFlags.SAMPLED) !== 0 };
}

/**
 * Formats a W3C `traceparent` value.
 */
export function formatTraceparent(parts: ParsedTraceparent): string {
  const flags = parts.sampled ? "01" : "00";
  return `00-${parts.traceId}-${parts.spanId}-${flags}`;
}

/**
 * Options for `Tracing.startSpan`. `parent` is a `traceparent` value; without
 * a valid one the span starts a new trace. `startTime` backdates the span.
 */
export interface StartSpanOptions {
  readonly parent?: string | null | undefined;
  readonly attributes?: Attributes;
  readonly startTime?: Date;
  readonly kind?: "internal" | "server" | "producer" | "consumer";
}

/**
 * A span that has been started and not yet ended. A span that is never
 * ended is never exported, which is how a transaction that rolls back drops
 * the span it started.
 */
export interface TraceSpan {
  /**
   * The `traceparent` value children of this span use, or `undefined` when
   * tracing is off.
   */
  readonly traceparent: string | undefined;
  setAttributes(attributes: Attributes): void;
  /**
   * Marks the span as failed and records the error on it.
   */
  recordError(error: unknown): void;
  end(endTime?: Date): void;
}

/**
 * How the engine emits spans. Every span of a run hangs under the
 * `traceparent` stored on the run, so one run is one trace across the API,
 * workers, timers and child workflows.
 */
export interface Tracing {
  startSpan(name: string, options?: StartSpanOptions): TraceSpan;
}

const noopSpan: TraceSpan = {
  traceparent: undefined,
  setAttributes: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

/**
 * A `Tracing` that emits nothing. Used wherever tracing is not configured.
 */
export const noopTracing: Tracing = {
  startSpan: () => noopSpan,
};

const SPAN_KINDS = {
  internal: SpanKind.INTERNAL,
  server: SpanKind.SERVER,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
} as const;

function parentContext(parent: string | null | undefined): Context {
  const parsed = parseTraceparent(parent);
  if (parsed === undefined) {
    return ROOT_CONTEXT;
  }
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parsed.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}

function toTraceSpan(span: Span): TraceSpan {
  const spanContext = span.spanContext();
  return {
    traceparent: formatTraceparent({
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      sampled: (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0,
    }),
    setAttributes(attributes) {
      span.setAttributes(attributes);
    },
    recordError(error) {
      const exception = error instanceof Error ? error : new Error(String(error));
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
    },
    end(endTime) {
      span.end(endTime);
    },
  };
}

/**
 * Creates a `Tracing` that emits spans through an OpenTelemetry `tracer`.
 */
export function createTracing(tracer: Tracer): Tracing {
  return {
    startSpan(name, options = {}) {
      const span = tracer.startSpan(
        name,
        {
          kind: SPAN_KINDS[options.kind ?? "internal"],
          ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
          ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
        },
        parentContext(options.parent),
      );
      return toTraceSpan(span);
    },
  };
}
