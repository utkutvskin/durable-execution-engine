/**
 * The filters of the run list as the form holds them. Dates are `YYYY-MM-DD`
 * strings from a date input, empty when unset.
 */
export interface ListFilters {
  readonly status: string;
  readonly workflowType: string;
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function startOfDay(value: string): number | undefined {
  if (!DATE_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Builds the query string of `GET /v1/runs`. The `to` date is inclusive, so
 * it becomes an exclusive bound at the start of the next day. Empty and
 * malformed fields are left out.
 */
export function buildListQuery(
  filters: ListFilters,
  limit: number,
  cursor?: string,
): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.status !== "") {
    query.set("status", filters.status);
  }
  const workflowType = filters.workflowType.trim();
  if (workflowType !== "") {
    query.set("workflowType", workflowType);
  }
  const from = startOfDay(filters.from);
  if (from !== undefined) {
    query.set("startedAfter", new Date(from).toISOString());
  }
  const to = startOfDay(filters.to);
  if (to !== undefined) {
    query.set("startedBefore", new Date(to + DAY_MS).toISOString());
  }
  query.set("limit", String(limit));
  if (cursor !== undefined) {
    query.set("cursor", cursor);
  }
  return query;
}
