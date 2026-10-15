import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createTracing, type Tracing } from "./tracing.js";

/**
 * Settings for `createTracingProvider`. `samplingRatio` (default 1) is the
 * share of new traces that are recorded; a run whose stored `traceparent`
 * says sampled or not sampled keeps that decision in every process.
 * `exporter` overrides the OTLP HTTP exporter built from `otlpEndpoint`
 * (for example `http://localhost:4318/v1/traces`). `spanProcessors` replaces
 * the batching processor, which tests use to export synchronously.
 */
export interface TracingProviderOptions {
  readonly serviceName: string;
  readonly otlpEndpoint?: string;
  readonly samplingRatio?: number;
  readonly exporter?: SpanExporter;
  readonly spanProcessors?: readonly SpanProcessor[];
}

/**
 * A configured tracing setup: the `Tracing` the engine emits through and a
 * `shutdown` that flushes pending spans.
 */
export interface TracingProvider {
  readonly tracing: Tracing;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Creates the OpenTelemetry provider for one process. Throws a `RangeError`
 * when `samplingRatio` is outside 0 to 1.
 */
export function createTracingProvider(options: TracingProviderOptions): TracingProvider {
  const ratio = options.samplingRatio ?? 1;
  if (!(ratio >= 0 && ratio <= 1)) {
    throw new RangeError(`samplingRatio must be between 0 and 1, got ${String(ratio)}`);
  }
  const exporter =
    options.exporter ??
    new OTLPTraceExporter(options.otlpEndpoint === undefined ? {} : { url: options.otlpEndpoint });
  const spanProcessors = options.spanProcessors ?? [new BatchSpanProcessor(exporter)];
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": options.serviceName }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
    spanProcessors: [...spanProcessors],
  });
  return {
    tracing: createTracing(provider.getTracer("@dee/core")),
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
