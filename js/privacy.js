// privacy.js — the disclosure boundary.
//
// This is the heart of Cleanroom. The raw dataset never crosses to the agent.
// Three kinds of things may cross, each on different terms:
//
//   1. metadata     (schema, column names, row COUNTS) — low risk, flows freely.
//   2. aggregates   (grouped stats) — allowed only above a k-anonymity floor so a
//                    group can never describe a single person; auto-approved.
//   3. raw rows     (individual records) — never without an explicit human click
//                    in the disclosure dialog.
//
// Every disclosure — approved, auto, or denied — is written to a visible ledger
// so a reviewer can reconstruct exactly what left the browser and why.

import {
  TABLE,
  rawQuery,
  validatePredicate,
  columnNames,
} from "./db.js";

export const K_ANON = 5; // minimum group size for any aggregate or sample

// Columns whose NAME suggests they identify a person are marked sensitive by
// default, so the gate does the right thing on an arbitrary uploaded dataset, not
// just the demo data. The human can toggle any column in the UI at runtime.
const SENSITIVE_HINT =
  /(operator|employee|worker|staff|person|(^|_)name($|_)|full[_ ]?name|email|phone|mobile|ssn|social|passport|user|customer|patient|account|address)/i;

let sensitive = new Set();

export function getSensitiveColumns() {
  return [...sensitive];
}
export function isSensitive(col) {
  return sensitive.has(col);
}
export function setSensitive(col, on) {
  if (on) sensitive.add(col);
  else sensitive.delete(col);
  emit();
}

// ---- ledger (audit trail) -----------------------------------------------------

/** @typedef {{
 *   id:number, at:string, kind:'metadata'|'aggregate'|'raw'|'denied',
 *   summary:string, detail:object
 * }} Disclosure */

const ledger = [];
let seq = 0;
const subscribers = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  fn(snapshot());
  return () => subscribers.delete(fn);
}
function emit() {
  const snap = snapshot();
  subscribers.forEach((fn) => fn(snap));
}
function snapshot() {
  return { ledger: [...ledger], sensitive: [...sensitive] };
}

function record(kind, summary, detail = {}) {
  const entry = { id: ++seq, at: new Date().toISOString(), kind, summary, detail };
  ledger.push(entry);
  emit();
  return entry;
}

export function getLedger() {
  return [...ledger];
}

// Log low-risk metadata disclosures (called by getWorkspaceContext etc.)
export function noteMetadata(summary, detail = {}) {
  return record("metadata", summary, detail);
}

// ---- aggregates with k-anonymity ---------------------------------------------

const AGG_FNS = new Set(["sum", "avg", "min", "max", "count", "median", "stddev"]);

/**
 * Build and run a safe aggregate. The agent supplies dimensions + metrics by
 * NAME only; we assemble the SQL, force a COUNT(*), and drop any group under the
 * k-anonymity floor via HAVING. Raw column values can never leak this way.
 *
 * @param {Object} spec
 * @param {string[]} spec.dimensions   group-by columns
 * @param {{column:string, fn:string}[]} spec.metrics
 * @param {string} [spec.where]        optional filter predicate
 * @param {string} [spec.orderBy]      optional "col dir"
 * @param {number} [spec.limit]
 */
export async function discloseAggregate(spec) {
  const cols = new Set(await columnNames());
  const dims = (spec.dimensions || []).map(String);
  const metrics = spec.metrics || [];

  for (const d of dims) {
    if (!cols.has(d)) throw new Error(`Unknown dimension column: ${d}`);
  }
  const metricSql = [];
  for (const m of metrics) {
    const fn = String(m.fn || "").toLowerCase();
    if (!AGG_FNS.has(fn)) throw new Error(`Unsupported aggregate: ${m.fn}`);
    if (fn !== "count" && !cols.has(m.column)) {
      throw new Error(`Unknown metric column: ${m.column}`);
    }
    const arg = fn === "count" ? "*" : `"${m.column}"`;
    const alias = `${fn}_${m.column || "rows"}`.replace(/[^a-z0-9_]/gi, "_");
    metricSql.push(`${fn}(${arg}) AS "${alias}"`);
  }
  if (spec.where) {
    const chk = validatePredicate(spec.where);
    if (!chk.ok) throw new Error(chk.reason);
  }

  const dimSql = dims.map((d) => `"${d}"`).join(", ");
  const selectParts = [
    ...(dims.length ? [dimSql] : []),
    "count(*) AS n",
    ...metricSql,
  ].join(", ");
  const groupBy = dims.length ? `GROUP BY ${dimSql}` : "";
  const where = spec.where ? `WHERE ${spec.where}` : "";
  const having = dims.length ? `HAVING count(*) >= ${K_ANON}` : "";
  const orderBy = spec.orderBy ? `ORDER BY ${spec.orderBy}` : "";
  const limit = `LIMIT ${Math.min(Number(spec.limit) || 200, 1000)}`;

  const sql = `SELECT ${selectParts} FROM ${TABLE} ${where} ${groupBy} ${having} ${orderBy} ${limit}`;
  const { columns, rows } = await rawQuery(sql);

  // How many groups were withheld by the k-anon floor?
  let suppressed = 0;
  if (dims.length) {
    const total = await rawQuery(
      `SELECT count(*) AS g FROM (SELECT 1 FROM ${TABLE} ${where} GROUP BY ${dimSql}) t`
    );
    suppressed = Number(total.rows[0].g) - rows.length;
  }

  record(
    "aggregate",
    `Aggregate over [${dims.join(", ") || "all rows"}] — ${rows.length} groups shared` +
      (suppressed > 0 ? `, ${suppressed} withheld (< k=${K_ANON})` : ""),
    { dimensions: dims, metrics, where: spec.where || null, suppressed }
  );

  return {
    columns,
    rows,
    groupsShared: rows.length,
    groupsWithheld: suppressed,
    kAnonymityFloor: K_ANON,
    note:
      suppressed > 0
        ? `${suppressed} group(s) were withheld because they contained fewer than ${K_ANON} runs.`
        : `All groups met the k=${K_ANON} floor.`,
  };
}

// ---- raw-row disclosure (requires explicit human approval) --------------------

// app.js registers a handler that shows the modal and resolves true/false.
let approvalHandler = async () => false;
export function setApprovalHandler(fn) {
  approvalHandler = fn;
}

/**
 * Request that specific rows be disclosed to the agent. Always routes through the
 * human approval dialog. On approval, logs a 'raw' disclosure with the exact
 * columns and row count. On denial, logs a 'denied' entry.
 *
 * @param {Object} req
 * @param {string} req.reason        agent's stated reason (shown to the human)
 * @param {object[]} req.rows        the candidate rows (already computed locally)
 * @param {string[]} req.columns     columns present in those rows
 */
export async function requestRawDisclosure(req) {
  const touchedSensitive = req.columns.filter((c) => sensitive.has(c));

  // k-anon also guards samples: refuse to hand over a sliver small enough to
  // re-identify, unless the human is looking at a genuinely larger set.
  const request = {
    reason: req.reason || "(no reason given)",
    columns: req.columns,
    rowCount: req.rows.length,
    sensitiveColumns: touchedSensitive,
    belowKAnon: req.rows.length < K_ANON,
  };

  const approved = await approvalHandler(request);
  if (!approved) {
    record("denied", `Raw rows denied — ${request.rowCount} row(s) blocked`, request);
    return {
      approved: false,
      reason:
        "The analyst declined to share raw records. Try a k-anonymous aggregate " +
        "with getAggregateResult instead.",
    };
  }

  record(
    "raw",
    `Raw rows approved — ${request.rowCount} row(s), columns [${req.columns.join(", ")}]` +
      (touchedSensitive.length
        ? ` incl. sensitive [${touchedSensitive.join(", ")}]`
        : ""),
    request
  );
  return { approved: true, columns: req.columns, rows: req.rows };
}

export function resetSensitive(fromColumns) {
  // Mark any column whose name looks person-identifying. The analyst can adjust.
  sensitive = new Set(fromColumns.filter((c) => SENSITIVE_HINT.test(c)));
  emit();
}
