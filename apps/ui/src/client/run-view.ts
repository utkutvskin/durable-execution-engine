import { ApiError, type ApiClient, type RunDescription } from "./api.js";
import { h } from "./dom.js";
import { formatJson, formatOffset, formatTimestamp } from "./format.js";
import { buildTimeline, mergeEntries, type HistoryEntry, type TimelineItem } from "./timeline.js";

const RECONNECT_MS = 1000;

function confirmAction(question: string): boolean {
  return window.confirm(question);
}

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
 * event timeline kept live by the run stream, a signal form, a form that
 * sends an update or answers a query, and the cancel button. Returns a function that closes the stream.
 */
export function mountRunView(
  container: HTMLElement,
  api: ApiClient,
  runId: string,
  onError: (error: unknown) => void,
): () => void {
  const abort = new AbortController();
  let entries: readonly HistoryEntry[] = [];
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
  const interactionName = h("input", {
    testId: "interaction-name",
    type: "text",
    name: "interaction",
    placeholder: "update or query name",
  });
  const interactionArgument = h("textarea", {
    testId: "interaction-argument",
    name: "argument",
    rows: 2,
    placeholder: "argument (json, optional)",
  });
  const updateButton = h("button", { testId: "update-send", type: "submit" }, "send update");
  const queryButton = h(
    "button",
    { testId: "query-send", type: "button", onClick: () => void runQuery() },
    "run query",
  );
  const interactionResult = h("pre", { testId: "interaction-result" });

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
    updateButton.disabled = !open;
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
    if (!confirmAction(`cancel run ${runId}? the workflow will run its compensations.`)) {
      return;
    }
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

  function readInteraction(): { name: string; argument: unknown } | undefined {
    const name = interactionName.value.trim();
    if (name === "") {
      message.textContent = "an update or a query needs a name";
      return undefined;
    }
    if (interactionArgument.value.trim() === "") {
      return { name, argument: undefined };
    }
    try {
      return { name, argument: JSON.parse(interactionArgument.value) as unknown };
    } catch {
      message.textContent = "the argument is not valid json";
      return undefined;
    }
  }

  async function sendUpdate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const interaction = readInteraction();
    if (interaction === undefined) {
      return;
    }
    interactionResult.textContent = "";
    message.textContent = `update ${interaction.name} sent, waiting for its result`;
    try {
      const answer = await api.updateRun(runId, interaction.name, interaction.argument);
      if (answer.status === "completed") {
        interactionResult.textContent = formatJson(answer.result ?? null);
        message.textContent = `update ${interaction.name} completed`;
      } else if (answer.status === "failed") {
        message.textContent = `update ${interaction.name} failed: ${answer.error?.message ?? ""}`;
      } else {
        message.textContent = `update ${interaction.name} was accepted but has not finished yet`;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        message.textContent = error.message;
        return;
      }
      onError(error);
    }
  }

  async function runQuery(): Promise<void> {
    const interaction = readInteraction();
    if (interaction === undefined) {
      return;
    }
    try {
      const result = await api.queryRun(runId, interaction.name, interaction.argument);
      interactionResult.textContent = formatJson(result ?? null);
      message.textContent = `query ${interaction.name} answered`;
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        message.textContent = error.message;
        return;
      }
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
            entries = mergeEntries(entries, slice.events);
            after = Math.max(after, entries.at(-1)?.sequenceNumber ?? 0);
            renderTimeline();
            if (description?.status !== slice.status || slice.closed) {
              void refreshDescription();
            }
          },
          abort.signal,
        );
        after = Math.max(after, result.lastSequence);
        if (result.ended) {
          live.textContent = "closed";
          await refreshDescription();
          return;
        }
      } catch (error) {
        if (isAborted(abort.signal)) {
          return;
        }
        if (error instanceof ApiError && error.status !== 429) {
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
      h(
        "form",
        { testId: "interaction-form", onSubmit: (event) => void sendUpdate(event) },
        interactionName,
        interactionArgument,
        updateButton,
        queryButton,
      ),
      interactionResult,
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
