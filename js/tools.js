// tools.js — the seven WebMCP tools the agent can call.
//
// Design rules enforced here:
//   * Two getters were deliberately NOT built. There is no getSelectedRows (it
//     would bypass the disclosure gate) and no summarizeResult (the agent can
//     summarize returned data itself).
//   * executeLocalQuery returns metadata only — the human sees the rows, the
//     agent sees columns + count. Raw values reach the agent only via requestRows
//     (human-approved) or getAggregateResult (k-anonymous).
//   * Every tool returns a plain object; webmcp.js wraps it into an MCP result.

import { runReadOnly, getSchema, MAX_ROWS } from "./db.js";
import * as privacy from "./privacy.js";
import * as hyp from "./hypotheses.js";
import * as ws from "./state.js";

export const TOOLS = [
  // 1 ---------------------------------------------------------------------------
  {
    name: "getWorkspaceContext",
    description:
      "Read the current state of the analyst's workspace: dataset name, table " +
      "schema, the SQL currently in the editor, how many rows the last query " +
      "returned, how many rows the analyst has selected, the list of columns " +
      "marked sensitive, and a summary of open hypotheses. Returns metadata only " +
      "— never the actual cell values. Call this first to orient yourself.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const schema = await getSchema();
      const last = ws.getLastResult();
      const cards = hyp.list();
      privacy.noteMetadata("Workspace context read by agent", {
        columns: schema.map((c) => c.name),
      });
      return {
        datasetName: ws.getDatasetName(),
        schema,
        activeSql: ws.getActiveSql(),
        lastResult: last
          ? { queryId: last.queryId, columns: last.columns, rowCount: last.rowCount }
          : null,
        selectedRowCount: ws.getSelectionIndices().length,
        sensitiveColumns: privacy.getSensitiveColumns(),
        kAnonymityFloor: privacy.K_ANON,
        hypotheses: cards.map((c) => ({
          id: c.id,
          statement: c.statement,
          status: c.status,
          confidence: c.confidence,
          evidenceCount: c.evidence.length,
        })),
        note:
          "Cell values are not included. Use getAggregateResult for k-anonymous " +
          "statistics, or requestRows to ask the analyst to approve raw records.",
      };
    },
  },

  // 2 ---------------------------------------------------------------------------
  {
    name: "executeLocalQuery",
    description:
      "Run a read-only SQL query (SELECT / WITH only) against the local table " +
      "'runs'. The full results are shown to the analyst in the workspace grid " +
      "and the query is placed in the editor, but ONLY the column list and row " +
      "count are returned to you — not the rows themselves. Use this to drive the " +
      "analyst's view and to check the shape of a result before requesting data.",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "A single SELECT or WITH statement over the 'runs' table.",
        },
      },
      required: ["sql"],
    },
    execute: async ({ sql }) => {
      const result = await runReadOnly(sql);
      const queryId = ws.nextQueryId();
      ws.setActiveSql(sql);
      ws.setLastResult({ queryId, ...result });
      ws.focusSqlEditor(sql);
      return {
        queryId,
        columns: result.columns,
        rowCount: result.rowCount,
        truncated: result.truncated,
        rowCap: MAX_ROWS,
        note:
          "Results are displayed to the analyst. Row values are not returned to " +
          "you. To receive data, use getAggregateResult or requestRows.",
      };
    },
  },

  // 3 ---------------------------------------------------------------------------
  {
    name: "getAggregateResult",
    description:
      "Receive grouped statistics that are safe to share. You specify dimensions " +
      "(group-by columns) and metrics (e.g. sum of actual_units, avg of " +
      "filler_pressure_psi) by name; the workspace builds the SQL, always includes " +
      "a group count 'n', and withholds any group with fewer than k=5 runs so no " +
      "group can describe an individual. Optionally pass a 'where' filter and " +
      "'orderBy'. This is your main way to actually see numbers.",
    inputSchema: {
      type: "object",
      properties: {
        dimensions: {
          type: "array",
          items: { type: "string" },
          description: "Columns to group by (may be empty for a grand total).",
        },
        metrics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              fn: {
                type: "string",
                enum: ["sum", "avg", "min", "max", "count", "median", "stddev"],
              },
            },
            required: ["fn"],
          },
          description: "Aggregations to compute.",
        },
        where: {
          type: "string",
          description:
            "Optional SQL boolean filter, e.g. \"downtime_reason <> 'Planned Maintenance'\".",
        },
        orderBy: { type: "string", description: "Optional, e.g. \"n DESC\"." },
        limit: { type: "number" },
      },
      required: ["metrics"],
    },
    execute: async (args) => privacy.discloseAggregate(args),
  },

  // 4 ---------------------------------------------------------------------------
  {
    name: "requestRows",
    description:
      "Ask the analyst to approve sharing individual raw records with you. By " +
      "default this shares the rows the analyst has currently selected in the grid " +
      "(or the head of the last result if nothing is selected). A dialog shows the " +
      "analyst exactly which columns and how many rows would be shared and " +
      "highlights any sensitive columns; nothing is returned unless they approve. " +
      "Always give a clear 'reason'. Prefer getAggregateResult when you don't truly " +
      "need row-level detail.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you need raw rows (shown to the analyst).",
        },
        limit: {
          type: "number",
          description: "Max rows to request (capped at 50).",
        },
      },
      required: ["reason"],
    },
    execute: async ({ reason, limit }) => {
      const last = ws.getLastResult();
      if (!last) throw new Error("No query has been run yet.");
      const selected = ws.getSelectedRows();
      const cap = Math.min(Number(limit) || 20, 50);
      const candidate = (selected.length ? selected : last.rows).slice(0, cap);
      if (candidate.length === 0) throw new Error("There are no rows to share.");
      return privacy.requestRawDisclosure({
        reason,
        columns: last.columns,
        rows: candidate,
      });
    },
  },

  // 5 ---------------------------------------------------------------------------
  {
    name: "addHypothesis",
    description:
      "Create a visible hypothesis card in the investigation panel. Use this to " +
      "state a testable claim about the data before you gather evidence for it, " +
      "e.g. 'Output loss is concentrated on LINE-2 during the C shift.' Returns the " +
      "new card including its id.",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string" },
        confidence: {
          type: "number",
          description: "Your initial confidence, 0 to 1.",
        },
      },
      required: ["statement"],
    },
    execute: async ({ statement, confidence }) =>
      hyp.addHypothesis({ statement, confidence, author: "agent" }),
  },

  // 6 ---------------------------------------------------------------------------
  {
    name: "updateHypothesis",
    description:
      "Attach evidence to a hypothesis, change its confidence, set its status " +
      "(open / supported / rejected), or record an analyst correction. Include the " +
      "SQL you used as evidence so the conclusion stays reproducible. Supply the " +
      "card 'id' from addHypothesis or getWorkspaceContext.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        status: { type: "string", enum: ["open", "supported", "rejected"] },
        confidence: { type: "number" },
        correction: {
          type: "string",
          description: "A note recording how the analyst corrected the analysis.",
        },
        evidence: {
          type: "object",
          properties: {
            stance: { type: "string", enum: ["support", "conflict"] },
            note: { type: "string" },
            sql: { type: "string" },
          },
          required: ["stance", "note"],
        },
      },
      required: ["id"],
    },
    execute: async (args) => hyp.updateHypothesis(args),
  },

  // 7 ---------------------------------------------------------------------------
  {
    name: "exportInvestigation",
    description:
      "Produce a reproducible investigation report: every hypothesis with its " +
      "evidence and the SQL behind it, the list of supported findings, and the " +
      "full disclosure ledger showing exactly what data left the browser. The " +
      "report is downloaded for the analyst and a summary is returned to you.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
    },
    execute: async ({ title }) => {
      const report = {
        title: title || "Cleanroom Investigation Report",
        generatedAt: new Date().toISOString(),
        dataset: ws.getDatasetName(),
        supportedFindings: hyp.pinnedFindings(),
        hypotheses: hyp.list(),
        disclosureLedger: privacy.getLedger(),
        sensitiveColumns: privacy.getSensitiveColumns(),
        kAnonymityFloor: privacy.K_ANON,
      };
      ws.downloadFile(
        "cleanroom-investigation.json",
        JSON.stringify(report, null, 2)
      );
      return {
        savedAs: "cleanroom-investigation.json",
        findings: report.supportedFindings.length,
        hypotheses: report.hypotheses.length,
        disclosures: report.disclosureLedger.length,
        note: "The full report was downloaded to the analyst's device.",
      };
    },
  },
];
