# Plausible Analytics MCP Server

A strictly-validated, fully tested [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) answer questions about your website traffic using the [Plausible Analytics Stats API v2](https://plausible.io/docs/stats-api).

> Built by AI coding agents under Sabry's direction and review.
>
> Not yet exercised against a live Plausible account; all tests run against a mocked HTTP layer.

Ask things like *"How did signups trend week over week this quarter?"*, *"Which campaigns drove the most conversions last month?"* or *"How many people are on the site right now?"* and the model calls strict, read-only tools against your Plausible account.

## Why this exists

Plausible is a privacy-friendly analytics product that many B2B SaaS teams use in place of Google Analytics. Its Stats API v2 is a single, well-documented `POST /api/v2/query` endpoint. That makes it a good base for a small MCP server that still has to handle the hard parts: strict input validation, readable errors, pagination, rate limits, timeouts, and keeping secrets out of logs.

## Features

- **5 read-only tools** covering totals, trends, top-N breakdowns, realtime traffic and access checks.
- **Strict input schemas** (zod). Unknown metrics or dimensions, malformed dates and invalid combinations are rejected *before* a request is made, so no calls from the 600/hour budget are wasted.
- **Rules from the docs enforced in the server.** Examples: `scroll_depth`/`time_on_page` need `event:page`; `conversion_rate` and revenue metrics need `event:goal`; session metrics can't be mixed with most event dimensions; `case_sensitive` works only with `is`/`contains`.
- **Actionable errors.** 400/401/402/403/404/429/5xx, timeouts and network failures each map to a message that tells the model what to do next. They come back as `isError` tool results, not protocol failures.
- **Reliability**: per-request timeout, one bounded retry for transient 5xx/network errors, and no automatic retry on 429. Rate-limit responses include `Retry-After`.
- **Context-safe output**: Markdown tables by default or JSON on request. Pagination has an explicit `next_offset`, and a hard 25k-character budget drops whole rows so JSON stays valid.
- **Self-hosted friendly**: point `PLAUSIBLE_BASE_URL` at your own instance. Path prefixes behind a reverse proxy are supported.
- **No secrets in logs**: logs are structured JSON on stderr only. The API key is never logged, and it is redacted if an upstream error ever echoes it.

## Tools

| Tool | What it answers | Requests |
|---|---|---|
| `plausible_check_site_access` | "Can this key read `example.com`?" Also returns today's visitors as a smoke test | 1 |
| `plausible_get_aggregate` | Totals over a date range, e.g. visitors, bounce rate, conversions | 1 |
| `plausible_get_timeseries` | Metrics bucketed by hour/day/week/month, with empty buckets filled in | 1 |
| `plausible_get_breakdown` | Top pages/sources/countries/devices/UTMs/goals/custom props, paginated | 1 |
| `plausible_get_realtime_visitors` | Unique visitors in the last N minutes, plus the top pages they are on | 1–2 |

Every tool is annotated `readOnlyHint: true`, `destructiveHint: false`. `site_id` is optional on all tools when `PLAUSIBLE_DEFAULT_SITE_ID` is set.

### Common arguments

- `date_range`: a preset (`"day"`, `"24h"`, `"7d"`, `"28d"`, `"30d"`, `"91d"`, `"month"`, `"6mo"`, `"12mo"`, `"year"`, `"all"`) or a custom range `{"from": "2024-01-01", "to": "2024-01-31"}`. The custom range also accepts ISO datetimes with an offset.
- `metrics`: any of `visitors`, `visits`, `pageviews`, `views_per_visit`, `bounce_rate`, `visit_duration`, `events`, `scroll_depth`, `percentage`, `conversion_rate`, `group_conversion_rate`, `average_revenue`, `total_revenue`, `time_on_page`.
- `filters`: list of `{dimension, operator, values, case_sensitive?}`, combined with AND. Within one filter, `values` are ORed. The operators are `is`, `is_not`, `contains`, `contains_not`, `matches` and `matches_not` (re2 regex).
- Dimensions: `event:page`, `event:goal`, `event:hostname`, `visit:source`, `visit:channel`, `visit:referrer`, `visit:utm_*`, `visit:device`, `visit:browser`, `visit:os`, `visit:country_name`, `visit:city_name`, entry/exit pages, … and custom properties as `event:props:<name>`.
- `response_format`: `"markdown"` (default) or `"json"`.

### Examples

```jsonc
// plausible_get_aggregate: last 7 days for the pricing page
{ "site_id": "example.com", "date_range": "7d",
  "filters": [{ "dimension": "event:page", "operator": "is", "values": ["/pricing"] }] }

// plausible_get_timeseries: daily signups this month
{ "site_id": "example.com", "date_range": "month", "interval": "day",
  "metrics": ["visitors", "events"],
  "filters": [{ "dimension": "event:goal", "operator": "is", "values": ["Signup"] }] }

// plausible_get_breakdown: top 10 sources, then the next page
{ "site_id": "example.com", "dimensions": ["visit:source"], "date_range": "30d", "limit": 10 }
{ "site_id": "example.com", "dimensions": ["visit:source"], "date_range": "30d", "limit": 10, "offset": 10 }

// plausible_get_breakdown: conversion rate per campaign, case-insensitive country filter
{ "site_id": "example.com", "dimensions": ["visit:utm_campaign"],
  "metrics": ["visitors", "conversion_rate"],
  "filters": [
    { "dimension": "event:goal", "operator": "is", "values": ["Signup"] },
    { "dimension": "visit:country_name", "operator": "contains", "values": ["united"], "case_sensitive": false }
  ] }

// plausible_get_realtime_visitors
{ "site_id": "example.com", "window_minutes": 5, "top_pages": 5 }
```

Sample Markdown output from `plausible_get_breakdown`:

```
## example.com — 30d by visit:source

| visit:source | visitors |
| --- | --- |
| Google | 1,204 |
| Direct / None | 877 |

Rows 1-2 of 14. More available: call again with offset=2.
```

## Setup

Requirements: Node.js 22 or newer, and a Plausible **Stats API** key. The Stats API is a Business-plan feature on plausible.io and is available on self-hosted instances. To create a key: *Settings → API Keys → New API Key → Stats API*. The key is scoped to the team selected when you create it.

```bash
git clone https://github.com/go-ai-now/mcp-server-plausible.git && cd mcp-server-plausible
npm ci
npm run build
```

### Claude Desktop

Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "plausible": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-plausible/dist/index.js"],
      "env": {
        "PLAUSIBLE_API_KEY": "your-stats-api-key",
        "PLAUSIBLE_DEFAULT_SITE_ID": "example.com"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add plausible \
  --env PLAUSIBLE_API_KEY=your-stats-api-key \
  --env PLAUSIBLE_DEFAULT_SITE_ID=example.com \
  -- node /absolute/path/to/mcp-server-plausible/dist/index.js
```

Or commit a project-scoped `.mcp.json` that reads the key from the developer's own environment, so the secret itself is never committed:

```json
{
  "mcpServers": {
    "plausible": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-plausible/dist/index.js"],
      "env": { "PLAUSIBLE_API_KEY": "${PLAUSIBLE_API_KEY}" }
    }
  }
}
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PLAUSIBLE_API_KEY` | yes | — | Stats API key. The server exits with a clear message if it is missing. |
| `PLAUSIBLE_BASE_URL` | no | `https://plausible.io` | Base URL for self-hosted instances, e.g. `https://stats.example.com`. Must be http(s) and must not contain credentials. |
| `PLAUSIBLE_DEFAULT_SITE_ID` | no | — | Site used when a tool call omits `site_id`. |
| `PLAUSIBLE_TIMEOUT_MS` | no | `15000` | Per-request timeout (1000–120000). |
| `PLAUSIBLE_MCP_DEBUG` | no | off | `1`/`true` logs one line per request (site, status, duration) to stderr. |

## Security notes

- **Read-only by design.** The server only calls `POST /api/v2/query`, which cannot change data. No write, delete or admin endpoints are wired in.
- **Least privilege.** Create a dedicated Stats API key for this server, scoped to the team whose sites the assistant should see. Revoke it in Plausible to cut off access instantly.
- **Secrets.** The key is read from the environment only. It is sent only in the `Authorization` header to `PLAUSIBLE_BASE_URL`, never logged, and redacted from any upstream error text before that text reaches the model.
- **Transport.** The server warns on startup if `PLAUSIBLE_BASE_URL` uses plain `http://` to a non-local host, because the key would travel unencrypted.
- **Untrusted input.** All tool arguments are validated against strict schemas: bounded lengths and counts, allow-listed metrics, dimensions and operators, and no unknown keys. Regex filters are evaluated by Plausible with re2, which is linear-time.
- **stdout hygiene.** stdout carries only MCP JSON-RPC. Diagnostics go to stderr.
- **Data exposure.** Plausible is designed not to collect personal data, but aggregate traffic numbers may still be business-sensitive. Treat the MCP client that holds this server as having read access to your analytics.

## Design notes

- **Why not a raw "run any query" tool?** Strict per-task tools give the model better affordances and better error messages. They also make it much harder to build a query that burns rate limit and fails. The four query tools cover the Stats API's documented use cases.
- **Realtime.** Stats API v2 has no dedicated realtime endpoint. Following the docs, "realtime" is a query over a short ISO datetime range (`[now − N min, now]` in UTC). The legacy v1 `/realtime/visitors` endpoint exists, but this server deliberately stays on v2 only.
- **No "list sites".** Listing sites belongs to the separate Sites API, which needs a different key type. `plausible_check_site_access` probes one site with a single cheap query instead.
- **Retries.** Queries are idempotent reads, so one retry on 5xx/network/timeout is safe. 429 is never retried automatically: that would spend more of the hourly budget, so the model gets `Retry-After` and decides.
- **Gap filling.** Timeseries asks Plausible for `time_labels` and fills empty buckets: `0` for counts, `null` for ratios. If returned buckets don't match the labels, the data is returned untouched rather than guessed.

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit (src + tests)
npm test            # vitest, fully offline: HTTP is stubbed, no API key needed
npm run build       # emits dist/
```

The tests cover:

- schema validation and the cross-field rules
- request building
- mapping of 400/401/402/429/5xx, timeouts, network errors and non-JSON responses
- secret redaction, including a check that no log line contains the key
- output limits and pagination maths
- end-to-end tests that connect a real MCP `Client` to the server over `InMemoryTransport` and call every tool

Project layout:

```
src/
  index.ts              stdio entry point (env -> config -> server)
  server.ts             createServer(): wires the client and tools; no process/env access
  config.ts             env parsing + validation
  logger.ts             stderr-only JSON logger
  format.ts             tables, units, character budget
  plausible/
    schema.ts           zod schemas + documented cross-field rules
    query-builder.ts    tool input -> /api/v2/query body
    client.ts           fetch wrapper: timeout, retry, error mapping
    errors.ts           typed errors and LLM-oriented messages
    types.ts            wire types
  tools/                one file per tool + shared plumbing
test/                   unit + end-to-end tests
```

## License

MIT © go-ai-now. See [LICENSE](LICENSE).

Not affiliated with or endorsed by Plausible Insights OÜ. "Plausible" is used only to describe compatibility.
