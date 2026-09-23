/**
 * Wire types for `POST /api/v2/query`. Only the parts this server sends or reads are modelled.
 */

export type PlausibleDateRange = string | [string, string];

export type PlausibleFilterModifiers = { case_sensitive: boolean };

export type PlausibleSimpleFilter =
  | [operator: string, dimension: string, clauses: string[]]
  | [operator: string, dimension: string, clauses: string[], modifiers: PlausibleFilterModifiers];

export type PlausibleOrderBy = [dimensionOrMetric: string, direction: "asc" | "desc"];

export interface PlausibleInclude {
  imports?: boolean;
  time_labels?: boolean;
  total_rows?: boolean;
}

export interface PlausiblePagination {
  limit: number;
  offset: number;
}

export interface PlausibleQuery {
  site_id: string;
  metrics: string[];
  date_range: PlausibleDateRange;
  dimensions?: string[];
  filters?: PlausibleSimpleFilter[];
  order_by?: PlausibleOrderBy[];
  include?: PlausibleInclude;
  pagination?: PlausiblePagination;
}

/** Revenue metrics are returned as objects instead of numbers. */
export interface PlausibleRevenue {
  value: number;
  currency: string;
  short: string;
  long: string;
}

export type PlausibleMetricValue = number | PlausibleRevenue | null;

export interface PlausibleResultRow {
  metrics: PlausibleMetricValue[];
  dimensions: string[];
}

export interface PlausibleMetricWarning {
  code: string;
  warning: string;
}

export interface PlausibleMeta {
  imports_included?: boolean;
  imports_skip_reason?: string;
  imports_warning?: string;
  metric_warnings?: Record<string, PlausibleMetricWarning>;
  time_labels?: string[];
  total_rows?: number;
}

export interface PlausibleQueryResponse {
  results: PlausibleResultRow[];
  meta: PlausibleMeta;
  query: Record<string, unknown>;
}
