/**
 * One parsed sample line of the Prometheus text format.
 */
export interface ParsedSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>> & { readonly le?: string };
  readonly value: number;
}

/**
 * The result of `parsePrometheusText`: declared metric families (`# TYPE`)
 * with their help text, and every sample.
 */
export interface ParsedMetrics {
  readonly types: ReadonlyMap<string, string>;
  readonly help: ReadonlyMap<string, string>;
  readonly samples: readonly ParsedSample[];
}

const SAMPLE_PATTERN = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)$/;
const LABEL_PATTERN = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/**
 * Strictly parses Prometheus text exposition format 0.0.4. Throws on a line
 * that is neither a comment, blank nor a well-formed sample, on a sample
 * whose family has no `# TYPE`, and on a repeated `# TYPE`.
 */
export function parsePrometheusText(text: string): ParsedMetrics {
  const types = new Map<string, string>();
  const help = new Map<string, string>();
  const samples: ParsedSample[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const typeMatch = /^# TYPE (\S+) (counter|gauge|histogram|summary|untyped)$/.exec(line);
    if (typeMatch?.[1] !== undefined && typeMatch[2] !== undefined) {
      if (types.has(typeMatch[1])) {
        throw new Error(`repeated TYPE for ${typeMatch[1]}`);
      }
      types.set(typeMatch[1], typeMatch[2]);
      continue;
    }
    const helpMatch = /^# HELP (\S+) (.*)$/.exec(line);
    if (helpMatch?.[1] !== undefined) {
      help.set(helpMatch[1], helpMatch[2] ?? "");
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    const match = SAMPLE_PATTERN.exec(line);
    if (match?.[1] === undefined || match[4] === undefined) {
      throw new Error(`malformed sample line: ${line}`);
    }
    const labels: Record<string, string> = {};
    for (const label of (match[3] ?? "").matchAll(LABEL_PATTERN)) {
      labels[label[1] ?? ""] = (label[2] ?? "")
        .replaceAll('\\"', '"')
        .replaceAll("\\n", "\n")
        .replaceAll("\\\\", "\\");
    }
    const value = match[4] === "+Inf" ? Infinity : Number(match[4]);
    if (Number.isNaN(value) && match[4] !== "NaN") {
      throw new Error(`malformed sample value: ${line}`);
    }
    const family = match[1].replace(/_(bucket|sum|count)$/, "");
    if (!types.has(match[1]) && !types.has(family)) {
      throw new Error(`sample without TYPE: ${match[1]}`);
    }
    samples.push({ name: match[1], labels, value });
  }
  return { types, help, samples };
}
