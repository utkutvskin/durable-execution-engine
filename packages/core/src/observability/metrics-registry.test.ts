import { describe, expect, it } from "vitest";
import { createMetricsRegistry } from "./metrics-registry.js";
import { parsePrometheusText } from "./prometheus-text.js";

describe("metrics registry", () => {
  it("renders a counter and a gauge with help, type and labels", async () => {
    const registry = createMetricsRegistry();
    const counter = registry.counter({ name: "jobs_total", help: "jobs done" });
    const gauge = registry.gauge({ name: "depth", help: "queue depth" });
    counter.inc({ queue: "a" });
    counter.inc({ queue: "a" }, 2);
    gauge.set({ queue: "b" }, 7);
    const parsed = parsePrometheusText(await registry.render());
    expect(parsed.types.get("jobs_total")).toBe("counter");
    expect(parsed.types.get("depth")).toBe("gauge");
    expect(parsed.help.get("depth")).toBe("queue depth");
    expect(parsed.samples).toContainEqual({ name: "jobs_total", labels: { queue: "a" }, value: 3 });
    expect(parsed.samples).toContainEqual({ name: "depth", labels: { queue: "b" }, value: 7 });
  });

  it("escapes quotes, backslashes and newlines in label values", async () => {
    const registry = createMetricsRegistry();
    const gauge = registry.gauge({ name: "odd", help: "odd labels" });
    const value = 'a"b\\c\nd';
    gauge.set({ name: value }, 1);
    const parsed = parsePrometheusText(await registry.render());
    expect(parsed.samples[0]?.labels).toEqual({ name: value });
  });

  it("renders cumulative histogram buckets with sum and count", async () => {
    const registry = createMetricsRegistry();
    const histogram = registry.histogram({ name: "wait_seconds", help: "wait", buckets: [1, 5] });
    histogram.observe({}, 0.5);
    histogram.observe({}, 3);
    histogram.observe({}, 9);
    const samples = parsePrometheusText(await registry.render()).samples;
    const bucket = (le: string): number | undefined =>
      samples.find((sample) => sample.name === "wait_seconds_bucket" && sample.labels.le === le)
        ?.value;
    expect(bucket("1")).toBe(1);
    expect(bucket("5")).toBe(2);
    expect(bucket("+Inf")).toBe(3);
    expect(samples.find((sample) => sample.name === "wait_seconds_sum")?.value).toBe(12.5);
    expect(samples.find((sample) => sample.name === "wait_seconds_count")?.value).toBe(3);
  });

  it("runs before-render hooks on every render", async () => {
    const registry = createMetricsRegistry();
    const gauge = registry.gauge({ name: "ticks", help: "ticks" });
    let calls = 0;
    registry.beforeRender(() => {
      calls += 1;
      gauge.set({}, calls);
      return Promise.resolve();
    });
    await registry.render();
    const parsed = parsePrometheusText(await registry.render());
    expect(parsed.samples[0]?.value).toBe(2);
  });

  it("refuses duplicate names, invalid names, invalid labels and decreasing counters", () => {
    const registry = createMetricsRegistry();
    const counter = registry.counter({ name: "once", help: "x" });
    expect(() => registry.gauge({ name: "once", help: "x" })).toThrow(/already registered/);
    expect(() => registry.gauge({ name: "9bad", help: "x" })).toThrow(/invalid metric name/);
    expect(() => {
      counter.inc({ "bad-label": "x" });
    }).toThrow(/invalid label name/);
    expect(() => {
      counter.inc({}, -1);
    }).toThrow(RangeError);
  });
});
