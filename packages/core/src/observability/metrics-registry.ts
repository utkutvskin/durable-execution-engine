/**
 * Label values of one sample, keyed by label name.
 */
export type Labels = Readonly<Record<string, string>>;

/**
 * A monotonically increasing value per label set.
 */
export interface Counter {
  inc(labels?: Labels, amount?: number): void;
  /** Sets the value outright, for counters mirrored from a durable source. */
  set(labels: Labels, value: number): void;
}

/**
 * A value that moves both ways per label set.
 */
export interface Gauge {
  set(labels: Labels, value: number): void;
  clear(): void;
}

/**
 * Observations bucketed against fixed upper bounds, per label set.
 */
export interface Histogram {
  observe(labels: Labels, value: number): void;
}

/**
 * Definition shared by every metric kind.
 */
export interface MetricDefinition {
  readonly name: string;
  readonly help: string;
}

/**
 * A set of metrics that renders itself in the Prometheus text exposition
 * format (version 0.0.4). `beforeRender` hooks run, in order, at the start of
 * every `render`, so a metric can be refreshed from its source on scrape.
 */
export interface MetricsRegistry {
  counter(definition: MetricDefinition): Counter;
  gauge(definition: MetricDefinition): Gauge;
  histogram(definition: MetricDefinition & { readonly buckets: readonly number[] }): Histogram;
  beforeRender(hook: () => Promise<void>): void;
  render(): Promise<string>;
}

/**
 * The `Content-Type` of the text `MetricsRegistry.render` produces.
 */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface Family {
  readonly name: string;
  readonly help: string;
  readonly type: "counter" | "gauge" | "histogram";
  lines(): string[];
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function escapeHelp(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "+Inf" : "-Inf";
  }
  return String(value);
}

function keyOf(labels: Labels): string {
  for (const name of Object.keys(labels)) {
    if (!LABEL_PATTERN.test(name)) {
      throw new TypeError(`invalid label name: ${name}`);
    }
  }
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function formatLabels(entries: readonly (readonly [string, string])[]): string {
  if (entries.length === 0) {
    return "";
  }
  const body = entries.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(",");
  return `{${body}}`;
}

function entriesOf(key: string): [string, string][] {
  return JSON.parse(key) as [string, string][];
}

/**
 * Creates an empty `MetricsRegistry`. Registering two metrics under one name
 * throws.
 */
export function createMetricsRegistry(): MetricsRegistry {
  const families = new Map<string, Family>();
  const hooks: (() => Promise<void>)[] = [];

  function register(family: Family): void {
    if (!NAME_PATTERN.test(family.name)) {
      throw new TypeError(`invalid metric name: ${family.name}`);
    }
    if (families.has(family.name)) {
      throw new Error(`metric already registered: ${family.name}`);
    }
    families.set(family.name, family);
  }

  function scalar(
    definition: MetricDefinition,
    type: "counter" | "gauge",
  ): { values: Map<string, number> } {
    const values = new Map<string, number>();
    register({
      ...definition,
      type,
      lines: () =>
        [...values.entries()].map(
          ([key, value]) =>
            `${definition.name}${formatLabels(entriesOf(key))} ${formatNumber(value)}`,
        ),
    });
    return { values };
  }

  return {
    counter(definition): Counter {
      const { values } = scalar(definition, "counter");
      return {
        inc(labels = {}, amount = 1): void {
          if (amount < 0) {
            throw new RangeError("a counter cannot decrease");
          }
          const key = keyOf(labels);
          values.set(key, (values.get(key) ?? 0) + amount);
        },
        set(labels, value): void {
          values.set(keyOf(labels), value);
        },
      };
    },

    gauge(definition): Gauge {
      const { values } = scalar(definition, "gauge");
      return {
        set(labels, value): void {
          values.set(keyOf(labels), value);
        },
        clear(): void {
          values.clear();
        },
      };
    },

    histogram(definition): Histogram {
      const bounds = [...definition.buckets].sort((a, b) => a - b);
      const series = new Map<string, { counts: number[]; sum: number; count: number }>();
      register({
        name: definition.name,
        help: definition.help,
        type: "histogram",
        lines: () =>
          [...series.entries()].flatMap(([key, entry]) => {
            const base = entriesOf(key);
            const rows = bounds.map(
              (bound, index) =>
                `${definition.name}_bucket${formatLabels([...base, ["le", formatNumber(bound)]])} ${String(entry.counts[index] ?? 0)}`,
            );
            rows.push(
              `${definition.name}_bucket${formatLabels([...base, ["le", "+Inf"]])} ${String(entry.count)}`,
              `${definition.name}_sum${formatLabels(base)} ${formatNumber(entry.sum)}`,
              `${definition.name}_count${formatLabels(base)} ${String(entry.count)}`,
            );
            return rows;
          }),
      });
      return {
        observe(labels, value): void {
          const key = keyOf(labels);
          let entry = series.get(key);
          if (entry === undefined) {
            entry = { counts: bounds.map(() => 0), sum: 0, count: 0 };
            series.set(key, entry);
          }
          bounds.forEach((bound, index) => {
            if (value <= bound) {
              entry.counts[index] = (entry.counts[index] ?? 0) + 1;
            }
          });
          entry.sum += value;
          entry.count += 1;
        },
      };
    },

    beforeRender(hook): void {
      hooks.push(hook);
    },

    async render(): Promise<string> {
      for (const hook of hooks) {
        await hook();
      }
      const blocks = [...families.values()].map((family) =>
        [
          `# HELP ${family.name} ${escapeHelp(family.help)}`,
          `# TYPE ${family.name} ${family.type}`,
          ...family.lines(),
        ].join("\n"),
      );
      return `${blocks.join("\n")}\n`;
    },
  };
}
