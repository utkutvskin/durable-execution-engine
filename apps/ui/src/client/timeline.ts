/**
 * One event of a run history as the api returns it.
 */
export interface HistoryEntry {
  readonly sequenceNumber: number;
  readonly createdAt: string;
  readonly event: { readonly type: string } & Readonly<Record<string, unknown>>;
}

/**
 * How an event is coloured in the timeline.
 */
export type Tone = "neutral" | "good" | "bad" | "warn";

/**
 * A history event prepared for display: a label, a one line summary, the time
 * since the run started and the raw event for the detail panel.
 */
export interface TimelineItem {
  readonly sequenceNumber: number;
  readonly type: string;
  readonly label: string;
  readonly summary: string;
  readonly tone: Tone;
  readonly offsetMs: number;
  readonly at: string;
  readonly event: HistoryEntry["event"];
}

interface Presentation {
  readonly label: string;
  readonly tone: Tone;
  readonly summary: (event: HistoryEntry["event"]) => string;
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function errorText(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const { name, message } = value as { name?: unknown; message?: unknown };
    return `${text(name)}: ${text(message)}`;
  }
  return "";
}

const PRESENTATIONS: Readonly<Record<string, Presentation>> = {
  run_started: { label: "run started", tone: "neutral", summary: (e) => text(e["workflowType"]) },
  run_completed: { label: "run completed", tone: "good", summary: () => "" },
  run_failed: { label: "run failed", tone: "bad", summary: (e) => errorText(e["error"]) },
  run_timed_out: { label: "run timed out", tone: "bad", summary: () => "" },
  run_cancelled: { label: "run cancelled", tone: "warn", summary: (e) => text(e["reason"]) },
  cancel_requested: {
    label: "cancel requested",
    tone: "warn",
    summary: (e) => text(e["reason"]),
  },
  run_terminated: { label: "run terminated", tone: "bad", summary: (e) => text(e["reason"]) },
  run_continued_as_new: { label: "continued as new", tone: "neutral", summary: () => "" },
  step_scheduled: {
    label: "step scheduled",
    tone: "neutral",
    summary: (e) => `${text(e["stepType"])} (${text(e["stepId"])})`,
  },
  step_completed: { label: "step completed", tone: "good", summary: (e) => text(e["stepId"]) },
  step_failed: {
    label: "step failed",
    tone: "bad",
    summary: (e) => `${text(e["stepId"])}: ${errorText(e["error"])}`,
  },
  step_attempt_failed: {
    label: "step attempt failed",
    tone: "warn",
    summary: (e) => `${text(e["stepId"])} attempt ${text(e["attempt"])}: ${errorText(e["error"])}`,
  },
  timer_started: {
    label: "timer started",
    tone: "neutral",
    summary: (e) => `${text(e["timerId"])} fires at ${text(e["fireAt"])}`,
  },
  timer_fired: { label: "timer fired", tone: "good", summary: (e) => text(e["timerId"]) },
  signal_received: {
    label: "signal received",
    tone: "neutral",
    summary: (e) => text(e["signalName"]),
  },
  child_started: {
    label: "child started",
    tone: "neutral",
    summary: (e) => `${text(e["workflowType"])} (${text(e["childId"])})`,
  },
  child_completed: { label: "child completed", tone: "good", summary: (e) => text(e["childId"]) },
  child_failed: {
    label: "child failed",
    tone: "bad",
    summary: (e) => `${text(e["childId"])}: ${errorText(e["error"])}`,
  },
  patch_recorded: { label: "patch recorded", tone: "neutral", summary: (e) => text(e["patchId"]) },
};

/**
 * Turns history entries into timeline items. Offsets are measured from the
 * first entry, so a partial list given later still lines up when the caller
 * passes `originMs`.
 */
export function buildTimeline(entries: readonly HistoryEntry[], originMs?: number): TimelineItem[] {
  const first = entries[0];
  const origin = originMs ?? (first === undefined ? 0 : Date.parse(first.createdAt));
  return entries.map((entry) => {
    const presentation = PRESENTATIONS[entry.event.type];
    return {
      sequenceNumber: entry.sequenceNumber,
      type: entry.event.type,
      label: presentation?.label ?? entry.event.type.replaceAll("_", " "),
      summary: presentation?.summary(entry.event) ?? "",
      tone: presentation?.tone ?? "neutral",
      offsetMs: Math.max(0, Date.parse(entry.createdAt) - origin),
      at: entry.createdAt,
      event: entry.event,
    };
  });
}
