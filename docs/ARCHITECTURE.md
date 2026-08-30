# Architecture

Cleanroom is a single-page app with no backend. Everything below happens inside one browser tab.

## Data flow and the disclosure boundary

```
                    ┌──────────────────────── browser tab ────────────────────────┐
                    │                                                              │
   CSV / Parquet ──►│  file picker ──► DuckDB-WASM (table: runs)                   │
   (human only)     │                        │                                    │
                    │                        ▼                                    │
                    │   SQL editor ◄──► executeLocalQuery ──► results grid (human sees rows)
                    │                        │                                    │
                    │                        │  metadata only (columns, count)    │
                    │        ══════════ DISCLOSURE BOUNDARY ══════════            │
                    │                        │                                    │
   AI agent  ◄──────┼── WebMCP tools ◄───────┤                                    │
   (ChatGPT /       │        ▲               ├─ getAggregateResult  (k ≥ 5)       │
    Chrome)         │        │               ├─ requestRows ──► approval dialog ──► human
                    │        │               └─ getWorkspaceContext (metadata)    │
                    │        └───────────── every crossing ──► disclosure ledger  │
                    └──────────────────────────────────────────────────────────────┘
```

The agent never has a handle to the DuckDB connection or the raw rows. It can only call the seven registered tools. Three of them can return data, and each is constrained differently.

## Module responsibilities

- **`webmcp.js`** — the only file that touches `navigator.modelContext` / `document.modelContext`. Detects the live surface, normalizes tool return values into the MCP result shape (`{ content, structuredContent }`), registers each tool under both `execute` and `handler` callback names, and wraps every handler in try/catch so a thrown error becomes a structured result rather than a broken call.
- **`db.js`** — boots DuckDB-WASM (auto-selecting the threaded vs single-threaded bundle), loads datasets (human action only), exposes schema, and enforces the read-only SQL guardrail. Results are row-capped (`MAX_ROWS`) and time-boxed (`QUERY_TIMEOUT_MS`).
- **`privacy.js`** — owns the disclosure boundary. Tracks sensitive columns, builds k-anonymous aggregates, runs the raw-row approval flow, and maintains the audit ledger with a pub/sub for the UI.
- **`hypotheses.js`** — the reproducible investigation record: cards with evidence (support/conflict), SQL provenance, confidence, status, and analyst corrections.
- **`tools.js`** — declares the seven tools and wires them to the modules above. This is where the privacy posture of each tool is decided.
- **`state.js`** — the shared surface between UI and tools: dataset name, active SQL, last result, current selection. Prevents a circular import between `app.js` and `tools.js`.
- **`app.js`** — the human side. Renders the grid, handles row selection, shows the disclosure modal, draws the ledger and hypothesis cards, and installs the two hooks the tools depend on (`renderResult`, the approval handler).

## Tool contracts

### `getWorkspaceContext() → object`
Returns `{ datasetName, schema, activeSql, lastResult:{queryId,columns,rowCount}, selectedRowCount, sensitiveColumns, kAnonymityFloor, hypotheses[] }`. No cell values. Logs a `metadata` disclosure.

### `executeLocalQuery({ sql }) → object`
Validates and runs read-only SQL. Updates the grid and editor for the human. Returns `{ queryId, columns, rowCount, truncated, rowCap }` — **no rows**.

### `getAggregateResult({ dimensions[], metrics[{column,fn}], where?, orderBy?, limit? }) → object`
Builds `SELECT <dims>, count(*) AS n, <metrics> FROM runs [WHERE …] GROUP BY <dims> HAVING count(*) >= 5`. Returns the surviving groups plus `{ groupsShared, groupsWithheld, kAnonymityFloor, note }`. Column names are validated against the schema; the optional `where` predicate is checked by the same blocklist as full queries. Logs an `aggregate` disclosure.

### `requestRows({ reason, limit? }) → object`
Takes the analyst's current selection (or the head of the last result), capped at 50 rows, and routes it through the human approval dialog. On approval returns `{ approved:true, columns, rows }` and logs a `raw` disclosure naming the exact columns (and flagging sensitive ones). On denial returns `{ approved:false, reason }` and logs a `denied` entry.

### `addHypothesis({ statement, confidence? }) → card`
Creates a card (`status:"open"`, `author:"agent"`).

### `updateHypothesis({ id, status?, confidence?, correction?, evidence:{stance,note,sql?} }) → card`
Appends evidence, adjusts confidence, sets status (`open`/`supported`/`rejected`), or records an analyst correction.

### `exportInvestigation({ title? }) → object`
Assembles `{ supportedFindings, hypotheses, disclosureLedger, sensitiveColumns, kAnonymityFloor }`, downloads it as JSON for the analyst, and returns a count summary to the agent.

## The k-anonymity floor

Aggregates are the main channel by which the agent receives numbers, so they carry the main re-identification risk. A `GROUP BY operator_id` where one operator has a single run would hand the agent that individual's data under the guise of a "statistic." The `HAVING count(*) >= K` clause (K = 5) drops any such group before it can cross the boundary, and the tool reports how many groups were withheld. The same floor is surfaced as a warning in the raw-row dialog when a requested sample is smaller than K.

## Failure and edge behavior

- Tool errors return `{ error:true, message }` rather than throwing — the agent surfaces the message to the user.
- A denied disclosure returns a structured result pointing the agent at `getAggregateResult` as the privacy-preserving alternative.
- If no agent surface is present, tool registration is a no-op and the human app is fully functional on its own.
- If DuckDB's threaded build can't initialize (no cross-origin isolation), it transparently falls back to the single-threaded build.
