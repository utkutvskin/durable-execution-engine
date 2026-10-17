/**
 * Renders a millisecond offset from the start of a run, such as `+0 ms`,
 * `+1.5 s` or `+2 min`.
 */
export function formatOffset(offsetMs: number): string {
  if (offsetMs < 1000) {
    return `+${String(Math.max(0, Math.round(offsetMs)))} ms`;
  }
  if (offsetMs < 60_000) {
    return `+${(offsetMs / 1000).toFixed(1)} s`;
  }
  return `+${(offsetMs / 60_000).toFixed(1)} min`;
}

/**
 * Pretty prints any json value for the viewers. `undefined` renders as
 * `null` so an empty field still shows something.
 */
export function formatJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value, null, 2);
}

/**
 * The first eight characters of an id, enough to tell runs apart in a list.
 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Renders an ISO timestamp as `YYYY-MM-DD HH:MM:SS` in UTC.
 */
export function formatTimestamp(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
}
