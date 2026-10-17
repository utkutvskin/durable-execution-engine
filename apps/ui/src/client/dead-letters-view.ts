import type { ApiClient, DeadLetter } from "./api.js";
import { h } from "./dom.js";
import { formatTimestamp, shortId } from "./format.js";

/**
 * Mounts the dead letter queue: every step task that ran out of attempts,
 * with a button that puts it back on its queue.
 */
export function mountDeadLettersView(
  container: HTMLElement,
  api: ApiClient,
  onError: (error: unknown) => void,
): () => void {
  const body = h("tbody", { testId: "dead-letter-rows" });
  const message = h("p", { className: "muted", testId: "dead-letter-message" });

  async function requeue(letter: DeadLetter): Promise<void> {
    try {
      await api.requeueDeadLetter(letter.id);
      message.textContent = `step ${letter.stepId} of run ${shortId(letter.runId)} was requeued`;
      await load();
    } catch (error) {
      onError(error);
    }
  }

  async function load(): Promise<void> {
    try {
      const letters = await api.listDeadLetters();
      body.replaceChildren(
        ...letters.map((letter) =>
          h(
            "tr",
            { testId: "dead-letter-row", attributes: { "data-dead-letter-id": letter.id } },
            h("td", {}, h("a", { href: `#/runs/${letter.runId}` }, shortId(letter.runId))),
            h("td", {}, letter.stepId),
            h("td", {}, String(letter.attempts)),
            h("td", {}, `${letter.error.name}: ${letter.error.message}`),
            h("td", {}, formatTimestamp(letter.createdAt)),
            h(
              "td",
              {},
              h(
                "button",
                { type: "button", testId: "requeue-button", onClick: () => void requeue(letter) },
                "requeue",
              ),
            ),
          ),
        ),
      );
      if (letters.length === 0) {
        body.replaceChildren(
          h("tr", {}, h("td", { attributes: { colspan: "6" } }, "the dead letter queue is empty")),
        );
      }
    } catch (error) {
      onError(error);
    }
  }

  container.replaceChildren(
    h("h2", {}, "Dead letter queue"),
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
          ...["run", "step", "attempts", "error", "dead lettered (utc)", ""].map((title) =>
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
