import type { ApiClient, Pause, PauseSubject, Schedule } from "./api.js";
import { h } from "./dom.js";
import { formatTimestamp } from "./format.js";

/**
 * Describes what a pause holds back, as the pauses table shows it.
 */
export function describePause(pause: Pause): string {
  if (pause.scope === "run") {
    return `run ${pause.runId ?? ""}`;
  }
  return pause.scope === "queue" ? `queue ${pause.queueName ?? ""}` : "the whole namespace";
}

function subjectOf(pause: Pause): PauseSubject {
  if (pause.scope === "run") {
    return { scope: "run", runId: pause.runId ?? "" };
  }
  return pause.scope === "queue"
    ? { scope: "queue", queueName: pause.queueName ?? "" }
    : { scope: "namespace" };
}

/**
 * Reads a `datetime-local` value as a UTC instant, or `undefined` when the
 * field is empty or not a time.
 */
export function utcInstant(value: string): string | undefined {
  if (value.trim() === "") {
    return undefined;
  }
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * Mounts the flow control page: the namespace's pauses with a resume button
 * each, buttons that pause the api's queue or the namespace, and the
 * schedules with pause, resume and a backfill form per schedule.
 */
export function mountSchedulesView(
  container: HTMLElement,
  api: ApiClient,
  onError: (error: unknown) => void,
): () => void {
  const pauseRows = h("tbody", { testId: "pause-rows" });
  const scheduleRows = h("tbody", { testId: "schedule-rows" });
  const message = h("p", { className: "muted", testId: "schedules-message" });

  async function act(work: () => Promise<string>): Promise<void> {
    try {
      message.textContent = await work();
      await load();
    } catch (error) {
      onError(error);
    }
  }

  function renderPause(pause: Pause): HTMLElement {
    return h(
      "tr",
      { testId: "pause-row", attributes: { "data-scope": pause.scope } },
      h("td", {}, describePause(pause)),
      h("td", {}, pause.reason ?? ""),
      h("td", {}, formatTimestamp(pause.pausedAt)),
      h(
        "td",
        {},
        h(
          "button",
          {
            type: "button",
            testId: "resume-pause",
            onClick: () =>
              void act(async () => {
                await api.resume(subjectOf(pause));
                return `${describePause(pause)} resumed`;
              }),
          },
          "resume",
        ),
      ),
    );
  }

  function renderSchedule(schedule: Schedule): HTMLElement {
    const from = h("input", { type: "datetime-local", testId: "backfill-from" });
    const to = h("input", { type: "datetime-local", testId: "backfill-to" });
    const paused = schedule.state === "PAUSED";
    return h(
      "tr",
      { testId: "schedule-row", attributes: { "data-schedule-id": schedule.scheduleId } },
      h("td", {}, schedule.name),
      h("td", {}, `${schedule.cronExpression} (${schedule.timeZone})`),
      h("td", {}, schedule.workflowType),
      h("td", {}, schedule.overlapPolicy),
      h(
        "td",
        {},
        h(
          "span",
          { className: `badge badge-${schedule.state.toLowerCase()}`, testId: "schedule-state" },
          schedule.state,
        ),
      ),
      h("td", {}, schedule.nextFireAt === null ? "-" : formatTimestamp(schedule.nextFireAt)),
      h(
        "td",
        {},
        h(
          "button",
          {
            type: "button",
            testId: "toggle-schedule",
            onClick: () =>
              void act(async () => {
                if (paused) {
                  await api.resumeSchedule(schedule.scheduleId);
                } else {
                  await api.pauseSchedule(schedule.scheduleId);
                }
                return `schedule ${schedule.name} ${paused ? "resumed" : "paused"}`;
              }),
          },
          paused ? "resume" : "pause",
        ),
      ),
      h(
        "td",
        {},
        h(
          "form",
          {
            className: "backfill",
            testId: "backfill-form",
            onSubmit: (event) => {
              event.preventDefault();
              const start = utcInstant(from.value);
              const end = utcInstant(to.value);
              if (start === undefined || end === undefined) {
                message.textContent = "a backfill needs a start and an end (utc)";
                return;
              }
              void act(async () => {
                const triggers = await api.backfillSchedule(schedule.scheduleId, start, end);
                const started = triggers.filter((trigger) => trigger.outcome === "STARTED").length;
                return `backfill of ${schedule.name}: ${String(triggers.length)} triggers handled, ${String(started)} runs started`;
              });
            },
          },
          from,
          to,
          h("button", { type: "submit", testId: "backfill-send" }, "backfill"),
        ),
      ),
    );
  }

  async function load(): Promise<void> {
    try {
      const [pauses, schedules] = await Promise.all([api.listPauses(), api.listSchedules()]);
      pauseRows.replaceChildren(
        ...(pauses.length === 0
          ? [h("tr", {}, h("td", { attributes: { colspan: "4" } }, "nothing is paused"))]
          : pauses.map(renderPause)),
      );
      scheduleRows.replaceChildren(
        ...(schedules.length === 0
          ? [h("tr", {}, h("td", { attributes: { colspan: "8" } }, "no schedules"))]
          : schedules.map(renderSchedule)),
      );
    } catch (error) {
      onError(error);
    }
  }

  function pauseButton(testId: string, label: string, subject: PauseSubject): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        testId,
        onClick: () => {
          if (!window.confirm(`${label}? held tasks stay queued until resumed.`)) {
            return;
          }
          void act(async () => {
            await api.pause(subject, "paused from the ui");
            return `${label}: done`;
          });
        },
      },
      label,
    );
  }

  function table(head: readonly string[], body: HTMLElement): HTMLElement {
    return h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ...head.map((title) => h("th", {}, title)))),
      body,
    );
  }

  container.replaceChildren(
    h("h2", {}, "Pauses"),
    message,
    h(
      "p",
      { className: "actions" },
      pauseButton("pause-queue", "pause the queue", { scope: "queue" }),
      pauseButton("pause-namespace", "pause the namespace", { scope: "namespace" }),
    ),
    table(["paused", "reason", "since (utc)", ""], pauseRows),
    h("h2", {}, "Schedules"),
    table(
      ["name", "cron", "workflow", "overlap", "state", "next fire (utc)", "", "backfill (utc)"],
      scheduleRows,
    ),
  );
  void load();
  return () => undefined;
}
