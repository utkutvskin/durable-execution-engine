import type { ApiClient, QuarantinedTask } from "./api.js";
import { h } from "./dom.js";
import { formatTimestamp, shortId } from "./format.js";

/**
 * Mounts the quarantine: every task the engine stopped delivering, with a
 * button that puts it back on its queue with a fresh reclaim budget.
 */
export function mountQuarantineView(
  container: HTMLElement,
  api: ApiClient,
  onError: (error: unknown) => void,
): () => void {
  const body = h("tbody", { testId: "quarantine-rows" });
  const message = h("p", { className: "muted", testId: "quarantine-message" });

  async function release(task: QuarantinedTask): Promise<void> {
    if (
      !window.confirm(
        `release the ${task.taskType.toLowerCase()} of run ${shortId(task.runId)}? it is delivered again.`,
      )
    ) {
      return;
    }
    try {
      await api.releaseQuarantined(task.taskId);
      message.textContent = `the task of run ${shortId(task.runId)} was released`;
      await load();
    } catch (error) {
      onError(error);
    }
  }

  async function load(): Promise<void> {
    try {
      const tasks = await api.listQuarantined();
      body.replaceChildren(
        ...tasks.map((task) =>
          h(
            "tr",
            { testId: "quarantine-row", attributes: { "data-task-id": task.taskId } },
            h("td", {}, h("a", { href: `#/runs/${task.runId}` }, shortId(task.runId))),
            h("td", {}, task.taskType),
            h("td", {}, task.queueName),
            h("td", {}, task.reason),
            h("td", {}, formatTimestamp(task.quarantinedAt)),
            h(
              "td",
              {},
              h(
                "button",
                { type: "button", testId: "release-button", onClick: () => void release(task) },
                "release",
              ),
            ),
          ),
        ),
      );
      if (tasks.length === 0) {
        body.replaceChildren(
          h("tr", {}, h("td", { attributes: { colspan: "6" } }, "no task is quarantined")),
        );
      }
    } catch (error) {
      onError(error);
    }
  }

  container.replaceChildren(
    h("h2", {}, "Quarantined tasks"),
    message,
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...["run", "task", "queue", "reason", "quarantined (utc)", ""].map((title) =>
            h("th", {}, title),
          ),
        ),
      ),
      body,
    ),
  );
  void load();
  return () => undefined;
}
