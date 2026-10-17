import type { ApiClient, RunSummary } from "./api.js";
import { h } from "./dom.js";
import { formatTimestamp, shortId } from "./format.js";
import type { ListFilters } from "./query.js";

const PAGE_SIZE = 25;
const REFRESH_MS = 3000;
const STATUSES = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
  "CONTINUED_AS_NEW",
];

/**
 * Mounts the run list into `container`: filters, a table, load more paging
 * and a periodic refresh of what is loaded. Returns a function that stops
 * the refresh.
 */
export function mountRunsView(
  container: HTMLElement,
  api: ApiClient,
  namespaceName: string,
  onError: (error: unknown) => void,
): () => void {
  let filters: ListFilters = { status: "", workflowType: "", from: "", to: "" };
  let runs: readonly RunSummary[] = [];
  let nextCursor: string | undefined;
  let stopped = false;

  const status = h(
    "select",
    { testId: "filter-status", name: "status" },
    h("option", { value: "" }, "any status"),
    ...STATUSES.map((value) => h("option", { value }, value)),
  );
  const workflowType = h("input", {
    testId: "filter-type",
    type: "text",
    name: "workflowType",
    placeholder: "workflow type",
  });
  const from = h("input", { testId: "filter-from", type: "date", name: "from" });
  const to = h("input", { testId: "filter-to", type: "date", name: "to" });
  const body = h("tbody", { testId: "run-rows" });
  const loadMore = h(
    "button",
    { testId: "load-more", type: "button", onClick: () => void more() },
    "load more",
  );
  const summary = h("p", { className: "muted", testId: "run-count" });

  function readFilters(): ListFilters {
    return {
      status: status.value,
      workflowType: workflowType.value,
      from: from.value,
      to: to.value,
    };
  }

  function render(): void {
    body.replaceChildren(
      ...runs.map((run) =>
        h(
          "tr",
          { testId: "run-row", attributes: { "data-run-id": run.runId } },
          h(
            "td",
            {},
            h("span", { className: `badge badge-${run.status.toLowerCase()}` }, run.status),
          ),
          h("td", {}, run.workflowType),
          h("td", {}, namespaceName),
          h("td", {}, formatTimestamp(run.startedAt)),
          h(
            "td",
            {},
            h("a", { href: `#/runs/${run.runId}`, testId: "run-link" }, shortId(run.runId)),
          ),
        ),
      ),
    );
    loadMore.hidden = nextCursor === undefined;
    summary.textContent = `${String(runs.length)} runs shown`;
  }

  async function reload(): Promise<void> {
    try {
      const page = await api.listRuns(filters, Math.max(PAGE_SIZE, Math.min(runs.length, 200)));
      if (stopped) {
        return;
      }
      runs = page.runs;
      nextCursor = page.nextCursor;
      render();
    } catch (error) {
      onError(error);
    }
  }

  async function more(): Promise<void> {
    if (nextCursor === undefined) {
      return;
    }
    try {
      const page = await api.listRuns(filters, PAGE_SIZE, nextCursor);
      runs = [...runs, ...page.runs];
      nextCursor = page.nextCursor;
      render();
    } catch (error) {
      onError(error);
    }
  }

  function apply(event: SubmitEvent): void {
    event.preventDefault();
    filters = readFilters();
    runs = [];
    void reload();
  }

  container.replaceChildren(
    h("h2", {}, "Runs"),
    h(
      "form",
      { className: "filters", testId: "filters", onSubmit: apply },
      status,
      workflowType,
      h("label", {}, "from ", from),
      h("label", {}, "to ", to),
      h("button", { type: "submit", testId: "apply-filters" }, "apply"),
    ),
    summary,
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...["status", "workflow type", "namespace", "started (utc)", "run"].map((title) =>
            h("th", {}, title),
          ),
        ),
      ),
      body,
    ),
    loadMore,
  );
  void reload();
  const timer = setInterval(() => void reload(), REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
