import type { ApiClient, Batch, BatchRequest } from "./api.js";
import { h } from "./dom.js";
import { formatTimestamp, shortId } from "./format.js";

const OPERATIONS: readonly BatchRequest["operation"][] = [
  "cancel",
  "terminate",
  "signal",
  "reset",
  "requeue",
];

/**
 * Builds the request the batch form describes, or the reason it cannot: a
 * signal needs a name and a json payload if one is given, a reset is cut
 * before its failed step, and a rate must be a positive number.
 */
export function batchRequestOf(fields: {
  readonly operation: string;
  readonly query: string;
  readonly signalName: string;
  readonly payload: string;
  readonly rate: string;
}): BatchRequest | string {
  const operation = OPERATIONS.find((candidate) => candidate === fields.operation);
  if (operation === undefined) {
    return `unknown operation "${fields.operation}"`;
  }
  const rate = fields.rate.trim() === "" ? undefined : Number(fields.rate);
  if (rate !== undefined && (!Number.isFinite(rate) || rate <= 0)) {
    return "the rate must be a positive number of runs per second";
  }
  const base = {
    operation,
    query: fields.query.trim(),
    reason: "started from the ui",
    ...(rate === undefined ? {} : { runsPerSecond: rate }),
  };
  if (operation === "signal") {
    const name = fields.signalName.trim();
    if (name === "") {
      return "a signal batch needs a signal name";
    }
    if (fields.payload.trim() === "") {
      return { ...base, signal: { name } };
    }
    try {
      return { ...base, signal: { name, payload: JSON.parse(fields.payload) as unknown } };
    } catch {
      return "the payload is not valid json";
    }
  }
  if (operation === "reset") {
    return { ...base, resetPoint: { kind: "failed-step" } };
  }
  return base;
}

/**
 * The progress of a batch as the page shows it.
 */
export function formatBatchProgress(batch: Batch): string {
  return `${String(batch.applied)} applied, ${String(batch.skipped)} skipped, ${String(batch.remaining)} left of ${String(batch.total)}`;
}

/**
 * Mounts the batches page: a form that starts a batch operation over the runs
 * a visibility query matches, and the namespace's batches with their
 * progress. A reset batch cuts each run before its step that failed for good.
 */
export function mountBatchesView(
  container: HTMLElement,
  api: ApiClient,
  onError: (error: unknown) => void,
): () => void {
  const body = h("tbody", { testId: "batch-rows" });
  const message = h("p", { className: "muted", testId: "batch-message" });
  const operation = h(
    "select",
    { testId: "batch-operation", name: "operation" },
    ...OPERATIONS.map((name) => h("option", { attributes: { value: name } }, name)),
  );
  const query = h("input", {
    testId: "batch-query",
    type: "text",
    name: "query",
    placeholder: "visibility query, e.g. status = 'FAILED'",
  });
  const signalName = h("input", {
    testId: "batch-signal",
    type: "text",
    name: "signal",
    placeholder: "signal name (signal batches)",
  });
  const payload = h("input", {
    testId: "batch-payload",
    type: "text",
    name: "payload",
    placeholder: "signal payload (json, optional)",
  });
  const rate = h("input", {
    testId: "batch-rate",
    type: "text",
    name: "rate",
    placeholder: "runs per second (optional)",
  });

  async function load(): Promise<void> {
    try {
      const batches = await api.listBatches();
      body.replaceChildren(
        ...batches.map((batch) =>
          h(
            "tr",
            { testId: "batch-row", attributes: { "data-batch-id": batch.batchId } },
            h("td", {}, shortId(batch.batchId)),
            h("td", {}, batch.operation),
            h("td", {}, batch.query === "" ? "(every run)" : batch.query),
            h("td", {}, h("a", { href: `#/runs/${batch.runId}` }, batch.status)),
            h("td", {}, formatBatchProgress(batch)),
            h("td", {}, formatTimestamp(batch.createdAt)),
          ),
        ),
      );
      if (batches.length === 0) {
        body.replaceChildren(
          h("tr", {}, h("td", { attributes: { colspan: "6" } }, "no batch operation yet")),
        );
      }
    } catch (error) {
      onError(error);
    }
  }

  async function start(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const request = batchRequestOf({
      operation: operation.value,
      query: query.value,
      signalName: signalName.value,
      payload: payload.value,
      rate: rate.value,
    });
    if (typeof request === "string") {
      message.textContent = request;
      return;
    }
    if (
      !window.confirm(
        `${request.operation} every run matching ${request.query === "" ? "anything" : request.query}?`,
      )
    ) {
      return;
    }
    try {
      const batch = await api.startBatch(request);
      message.textContent = `batch ${shortId(batch.batchId)} started over ${String(batch.total)} runs`;
      await load();
    } catch (error) {
      onError(error);
    }
  }

  container.replaceChildren(
    h("h2", {}, "Batch operations"),
    h(
      "form",
      { testId: "batch-form", onSubmit: (event) => void start(event) },
      operation,
      query,
      signalName,
      payload,
      rate,
      h("button", { testId: "batch-start", type: "submit" }, "start batch"),
    ),
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
          ...["batch", "operation", "query", "status", "progress", "started (utc)"].map((title) =>
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
