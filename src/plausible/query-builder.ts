/**
 * Translates validated tool inputs into Plausible v2 query bodies.
 *
 * Tools expose a flat, LLM-friendly filter shape ({dimension, operator, values});
 * this module converts it to Plausible's positional tuple format.
 */
import type { DateRangeInput, FilterInput } from "./schema.js";
import type {
  PlausibleDateRange,
  PlausibleInclude,
  PlausibleOrderBy,
  PlausiblePagination,
  PlausibleQuery,
  PlausibleSimpleFilter,
} from "./types.js";

export interface OrderByInput {
  by: string;
  direction: "asc" | "desc";
}

export interface QueryInput {
  siteId: string;
  metrics: readonly string[];
  dateRange: DateRangeInput | PlausibleDateRange;
  dimensions?: readonly string[];
  filters?: readonly FilterInput[];
  orderBy?: readonly OrderByInput[];
  include?: PlausibleInclude;
  pagination?: PlausiblePagination;
}

export function toPlausibleDateRange(range: DateRangeInput | PlausibleDateRange): PlausibleDateRange {
  if (typeof range === "string" || Array.isArray(range)) {
    return range;
  }
  return [range.from, range.to];
}

export function toPlausibleFilter(filter: FilterInput): PlausibleSimpleFilter {
  const clauses = [...filter.values];
  if (filter.case_sensitive === undefined) {
    return [filter.operator, filter.dimension, clauses];
  }
  return [filter.operator, filter.dimension, clauses, { case_sensitive: filter.case_sensitive }];
}

/** Drops keys whose value is `false`/undefined so request bodies stay minimal and stable. */
function compactInclude(include: PlausibleInclude | undefined): PlausibleInclude | undefined {
  if (include === undefined) {
    return undefined;
  }
  const compact: PlausibleInclude = {};
  if (include.imports === true) compact.imports = true;
  if (include.time_labels === true) compact.time_labels = true;
  if (include.total_rows === true) compact.total_rows = true;
  return Object.keys(compact).length === 0 ? undefined : compact;
}

export function buildQuery(input: QueryInput): PlausibleQuery {
  const query: PlausibleQuery = {
    site_id: input.siteId,
    metrics: [...input.metrics],
    date_range: toPlausibleDateRange(input.dateRange),
  };
  if (input.dimensions !== undefined && input.dimensions.length > 0) {
    query.dimensions = [...input.dimensions];
  }
  if (input.filters !== undefined && input.filters.length > 0) {
    query.filters = input.filters.map(toPlausibleFilter);
  }
  if (input.orderBy !== undefined && input.orderBy.length > 0) {
    query.order_by = input.orderBy.map((order): PlausibleOrderBy => [order.by, order.direction]);
  }
  const include = compactInclude(input.include);
  if (include !== undefined) {
    query.include = include;
  }
  if (input.pagination !== undefined) {
    query.pagination = { ...input.pagination };
  }
  return query;
}

/**
 * Formats a Date as ISO8601 with an explicit `+00:00` offset and second precision,
 * matching the datetime format shown in the Plausible docs.
 */
export function toIsoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

/** Datetime range covering the last `minutes` minutes up to `now` (used for "realtime"). */
export function lastMinutesRange(now: Date, minutes: number): [string, string] {
  const from = new Date(now.getTime() - minutes * 60_000);
  return [toIsoSeconds(from), toIsoSeconds(now)];
}
