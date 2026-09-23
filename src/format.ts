/**
 * Response rendering shared by all tools: row objects, Markdown tables, warnings,
 * and a hard character budget so a single tool result cannot flood the model context.
 */
import type { PlausibleMeta, PlausibleMetricValue, PlausibleRevenue } from "./plausible/types.js";

export const CHARACTER_LIMIT = 25_000;

export type RowObject = Record<string, string | number | PlausibleRevenue | null>;

function isRevenue(value: PlausibleMetricValue): value is PlausibleRevenue {
  return typeof value === "object" && value !== null;
}

/** Zips dimension/metric names with a positional Plausible result row. */
export function toRowObject(
  dimensionNames: readonly string[],
  metricNames: readonly string[],
  row: { dimensions: readonly string[]; metrics: readonly PlausibleMetricValue[] },
): RowObject {
  const object: RowObject = {};
  dimensionNames.forEach((name, index) => {
    object[name] = row.dimensions[index] ?? null;
  });
  metricNames.forEach((name, index) => {
    object[name] = row.metrics[index] ?? null;
  });
  return object;
}

export function formatMetricValue(metric: string, value: RowObject[string]): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (typeof value === "string") {
    return value;
  }
  if (isRevenue(value)) {
    return value.long;
  }
  switch (metric) {
    case "bounce_rate":
    case "percentage":
    case "conversion_rate":
    case "group_conversion_rate":
    case "scroll_depth":
      return `${value}%`;
    case "visit_duration":
    case "time_on_page":
      return `${value}s`;
    default:
      return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
  }
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderMarkdownTable(columns: readonly string[], rows: readonly RowObject[]): string {
  if (rows.length === 0) {
    return "_No data for this query._";
  }
  const header = `| ${columns.map(escapeCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((column) => escapeCell(formatMetricValue(column, row[column] ?? null))).join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
}

/** Human-readable warnings Plausible attached to the response (imports, revenue, ...). */
export function collectWarnings(meta: PlausibleMeta): string[] {
  const warnings: string[] = [];
  if (meta.imports_warning !== undefined) {
    warnings.push(meta.imports_warning);
  }
  if (meta.metric_warnings !== undefined) {
    for (const [metric, warning] of Object.entries(meta.metric_warnings)) {
      warnings.push(`${metric}: ${warning.warning}`);
    }
  }
  return warnings;
}

export function renderWarnings(warnings: readonly string[]): string {
  return warnings.length === 0 ? "" : `\n\n**Warnings**\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

export function describeDateRange(range: string | readonly [string, string]): string {
  return typeof range === "string" ? range : `${range[0]} → ${range[1]}`;
}

export interface TruncationInfo {
  shownRows: number;
  totalRows: number;
}

/**
 * Renders as many leading rows as fit into CHARACTER_LIMIT. Rows are dropped rather than
 * cutting text mid-way, so JSON output stays valid and tables stay well-formed.
 * `render` receives truncation info (or undefined when everything fits) to add its own notice.
 */
export function renderWithinLimit<Row>(
  rows: readonly Row[],
  render: (rows: readonly Row[], truncation: TruncationInfo | undefined) => string,
): string {
  const full = render(rows, undefined);
  if (full.length <= CHARACTER_LIMIT) {
    return full;
  }
  let low = 0;
  let high = rows.length - 1;
  let best = render([], { shownRows: 0, totalRows: rows.length });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(rows.slice(0, middle), { shownRows: middle, totalRows: rows.length });
    if (candidate.length <= CHARACTER_LIMIT) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function truncationNotice(truncation: TruncationInfo | undefined, hint: string): string {
  return truncation === undefined
    ? ""
    : `\n\n[Truncated: showing ${truncation.shownRows} of ${truncation.totalRows} rows to stay under ${CHARACTER_LIMIT} characters. ${hint}]`;
}
