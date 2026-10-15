import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { createTracingProvider } from "./provider.js";
import { formatTraceparent, noopTracing, parseTraceparent } from "./tracing.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

function setup(samplingRatio?: number) {
  const exporter = new InMemorySpanExporter();
  const provider = createTracingProvider({
    serviceName: "test",
    ...(samplingRatio === undefined ? {} : { samplingRatio }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider };
}

describe("traceparent", () => {
  it("round-trips a sampled value", () => {
    const value = `00-${TRACE_ID}-${SPAN_ID}-01`;
    const parsed = parseTraceparent(value);
    expect(parsed).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
    expect(parsed === undefined ? "" : formatTraceparent(parsed)).toBe(value);
  });

  it("reads the sampled flag as false for flags 00", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["a wrong version", `01-${TRACE_ID}-${SPAN_ID}-01`],
    ["uppercase hex", `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
    ["a short trace id", `00-abcd-${SPAN_ID}-01`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${SPAN_ID}-01`],
    ["an all-zero span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
  ])("rejects %s", (_name, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });

  it("treats null and undefined as absent", () => {
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });
});

describe("tracing", () => {
  it("emits nothing and exposes no traceparent when tracing is off", () => {
    const span = noopTracing.startSpan("anything", { parent: `00-${TRACE_ID}-${SPAN_ID}-01` });
    span.recordError(new Error("ignored"));
    span.end();
    expect(span.traceparent).toBeUndefined();
  });

  it("hangs a span under the given traceparent", () => {
    const { exporter, provider } = setup();
    const span = provider.tracing.startSpan("child", { parent: `00-${TRACE_ID}-${SPAN_ID}-01` });
    span.end();
    const [exported] = exporter.getFinishedSpans();
    expect(exported?.spanContext().traceId).toBe(TRACE_ID);
    expect(exported?.parentSpanContext?.spanId).toBe(SPAN_ID);
  });

  it("starts a new trace when the parent is missing or invalid", () => {
    const { exporter, provider } = setup();
    provider.tracing.startSpan("a", { parent: "garbage" }).end();
    provider.tracing.startSpan("b").end();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.parentSpanContext === undefined)).toBe(true);
    expect(spans[0]?.spanContext().traceId).not.toBe(spans[1]?.spanContext().traceId);
  });

  it("gives a started span a traceparent its children can use", () => {
    const { exporter, provider } = setup();
    const parent = provider.tracing.startSpan("parent");
    const child = provider.tracing.startSpan("child", { parent: parent.traceparent });
    child.end();
    parent.end();
    const byName = new Map(exporter.getFinishedSpans().map((span) => [span.name, span]));
    expect(byName.get("child")?.parentSpanContext?.spanId).toBe(
      byName.get("parent")?.spanContext().spanId,
    );
  });

  it("backdates a span to the given start time and end time", () => {
    const { exporter, provider } = setup();
    const startTime = new Date("2026-01-01T00:00:00.000Z");
    const endTime = new Date("2026-01-01T00:00:10.000Z");
    provider.tracing.startSpan("timer", { startTime }).end(endTime);
    const [exported] = exporter.getFinishedSpans();
    const [startSeconds = 0] = exported?.startTime ?? [];
    const [endSeconds = 0] = exported?.endTime ?? [];
    expect(startSeconds).toBe(startTime.getTime() / 1000);
    expect(endSeconds - startSeconds).toBe(10);
  });

  it("marks a span failed and records the error", () => {
    const { exporter, provider } = setup();
    const span = provider.tracing.startSpan("step");
    span.recordError(new Error("boom"));
    span.end();
    const [exported] = exporter.getFinishedSpans();
    expect(exported?.status.code).toBe(SpanStatusCode.ERROR);
    expect(exported?.status.message).toBe("boom");
    expect(exported?.events.map((event) => event.name)).toContain("exception");
  });

  it("does not export a span that was started and never ended", () => {
    const { exporter, provider } = setup();
    provider.tracing.startSpan("rolled back");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("sampling", () => {
  it("records every trace by default", () => {
    const { exporter, provider } = setup();
    for (let index = 0; index < 20; index += 1) {
      provider.tracing.startSpan("root").end();
    }
    expect(exporter.getFinishedSpans()).toHaveLength(20);
  });

  it("records no new trace at ratio 0 and marks the traceparent unsampled", () => {
    const { exporter, provider } = setup(0);
    const span = provider.tracing.startSpan("root");
    span.end();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(parseTraceparent(span.traceparent)?.sampled).toBe(false);
  });

  it("keeps the decision of the stored parent in every later span", () => {
    const { exporter, provider } = setup(0);
    provider.tracing.startSpan("sampled child", { parent: `00-${TRACE_ID}-${SPAN_ID}-01` }).end();
    provider.tracing.startSpan("unsampled child", { parent: `00-${TRACE_ID}-${SPAN_ID}-00` }).end();
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["sampled child"]);
  });

  it("samples about the configured share of new traces", () => {
    const { exporter, provider } = setup(0.5);
    for (let index = 0; index < 400; index += 1) {
      provider.tracing.startSpan("root").end();
    }
    const recorded = exporter.getFinishedSpans().length;
    expect(recorded).toBeGreaterThan(120);
    expect(recorded).toBeLessThan(280);
  });

  it("rejects a ratio outside 0 to 1", () => {
    expect(() => createTracingProvider({ serviceName: "test", samplingRatio: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => createTracingProvider({ serviceName: "test", samplingRatio: -0.1 })).toThrow(
      RangeError,
    );
  });
});
