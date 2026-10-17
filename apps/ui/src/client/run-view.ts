import { ApiError, type ApiClient, type RunDescription } from "./api.js";
import { h } from "./dom.js";
import { formatJson, formatOffset, formatTimestamp } from "./format.js";
import { buildTimeline, type HistoryEntry, type TimelineItem } from "./timeline.js";

const RECONNECT_MS = 1000;

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function viewer(testId: string, title: string, value: unknown): HTMLElement {
  return h(
    "section",
    { className: "viewer" },
    h("h3", {}, title),
    h("pre", { testId }, formatJson(value)),
  );
}

/**
 * Mounts the detail of one run: status, input, output and error viewers, the
 * event timeline kept live by the run stream, a signal form and the cancel
 * button. Returns a function that closes the stream.
 */
export function mountRunView(
  container: HTMLElement,
  api: ApiClient,
  runId: string,
  onError: (error: unknown) => void,
): () => void {
  const abort = new AbortController();
  const entries: HistoryEntry[] = [];
  let description: RunDescription | undefined;

  const header = h("div", { testId: "run-header" });
  const live = h("span", { className: "live", testId: "live-indicator" }, "connecting");
  const viewers = h("div", { className: "viewers", testId: "viewers" });
  const timeline = h("ol", { className: "timeline", testId: "timeline" });
  const message = h("p", { className: "muted", testId: "action-message" });
  const signalName = h("input", {
    testId: "signal-name",
    type: "text",
    name: "signal",
    placeholder: "signal name",
  });
  const signalPayload = h("textarea", {
    testId: "signal-payload",
    name: "payload",
    rows: 2,
    placeholder: "payload (json, optional)",
  });
  const cancelButton = h(
    "button",
    { testId: "cancel-button", type: "button", onClick: () => void cancel() },
    "cancel run",
  );
  const signalButton = h("button", { testId: "signal-send", type: "submit" }, "send signal");

  function renderHeader(): void {
    if (description === undefined) {
      return;
    }
    const open = description.status === "RUNNING";
    header.replaceChildren(
      h("h2", {}, description.workflowType),
      h(
        "p",
        {},
        h(
          "span",
          { className: `badge badge-${description.status.toLowerCase()}`, testId: "run-status" },
          description.status,
        ),
        ` run ${description.runId} started ${formatTimestamp(description.startedAt)}`,
        description.closedAt === null ? "" : `, closed ${formatTimestamp(description.closedAt)}`,
      ),
    );
    viewers.replaceChildren(
      viewer("input-viewer", "input", description.input),
      viewer("output-viewer", "output", description.result),
      viewer("error-viewer", "error", description.error),
    );
    cancelButton.disabled = !open;
    signalButton.disabled = !open;
  }

  function renderItem(item: TimelineItem): HTMLElement {
    const detail = h(
      "pre",
      { className: "detail", testId: "timeline-detail" },
      formatJson(item.event),
    );
    detail.hidden = true;
    return h(
      "li",
      {
        className: `timeline-item tone-${item.tone}`,
        testId: "timeline-item",
        attributes: { "data-type": item.type, "data-seq": String(item.sequenceNumber) },
        onClick: () => {
          detail.hidden = !detail.hidden;
        },
      },
      h("span", { className: "seq" }, String(item.sequenceNumber)),
      h("span", { className: "label" }, item.label),
      h("span", { className: "summary" }, item.summary),
      h("span", { className: "offset" }, formatOffset(item.offsetMs)),
      detail,
    );
  }

  function renderTimeline(): void {
    timeline.replaceChildren(...buildTimeline(entries).map(renderItem));
  }

  async function refreshDescription(): Promise<void> {
    try {
      description = await api.describeRun(runId);
      renderHeader();
    } catch (error) {
      onError(error);
    }
  }

  async function cancel(): Promise<void> {
    try {
      await api.cancelRun(runId, "cancelled from the ui");
      message.textContent = "cancellation requested";
    } catch (error) {
      onError(error);
    }
  }

  async function sendSignal(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = signalName.value.trim();
    if (name === "") {
      message.textContent = "a signal needs a name";
      return;
    }
    let payload: unknown;
    if (signalPayload.value.trim() !== "") {
      try {
        payload = JSON.parse(signalPayload.value) as unknown;
      } catch {
        message.textContent = "the payload is not valid json";
        return;
      }
    }
    try {
      await api.signalRun(runId, name, payload);
      message.textContent = `signal ${name} sent`;
      signalName.value = "";
      signalPayload.value = "";
    } catch (error) {
      onError(error);
    }
  }

  async function follow(): Promise<void> {
    let after = 0;
    while (!isAborted(abort.signal)) {
      try {
        live.textContent = "live";
        const result = await api.streamRun(
          runId,
          after,
          (slice) => {
            entries.push(...slice.events);
            renderTimeline();
            if (description?.status !== slice.status || slice.closed) {
              void refreshDescription();
            }
          },
          abort.signal,
        );
        after = result.lastSequence;
        if (result.ended) {
          live.textContent = "closed";
          await refreshDescription();
          return;
        }
      } catch (error) {
        if (isAborted(abort.signal)) {
          return;
        }
        if (error instanceof ApiError) {
          onError(error);
          return;
        }
        live.textContent = "reconnecting";
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  }

  container.replaceChildren(
    h("p", {}, h("a", { href: "#/" }, "all runs")),
    header,
    h("p", {}, "stream: ", live),
    viewers,
    h(
      "section",
      { className: "actions" },
      h(
        "form",
        { testId: "signal-form", onSubmit: (event) => void sendSignal(event) },
        signalName,
        signalPayload,
        signalButton,
      ),
      cancelButton,
      message,
    ),
    h("h3", {}, "Event history"),
    timeline,
  );
  void refreshDescription();
  void follow();
  return () => {
    abort.abort();
  };
}
