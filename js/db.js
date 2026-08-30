// db.js — DuckDB-WASM engine wrapper + the read-only SQL guardrail.
//
// The raw dataset lives inside this browser tab, in DuckDB compiled to WebAssembly.
// There is no backend. The human's file picker is the ONLY path that registers a
// dataset (using read_csv / read_parquet). Agent-supplied SQL is never allowed to
// read files or mutate anything — it goes through validateReadOnly() first.

import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

export const MAX_ROWS = 5000;      // hard cap on any result set
export const QUERY_TIMEOUT_MS = 8000;
export const TABLE = "runs";       // the single working table name

let db = null;
let conn = null;
let schemaCache = null;

export async function initDb() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles); // picks mvp vs threaded build
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], {
      type: "text/javascript",
    })
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
  return webAssemblyThreads();
}

function webAssemblyThreads() {
  return typeof self !== "undefined" && self.crossOriginIsolated === true
    ? "multi-threaded"
    : "single-threaded";
}

// ---- dataset loading (HUMAN ACTION ONLY) --------------------------------------

export async function loadCsvText(name, text) {
  await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await db.registerFileText(`${name}`, text);
  await conn.query(
    `CREATE TABLE ${TABLE} AS
     SELECT * FROM read_csv_auto('${name}', header = true, sample_size = -1)`
  );
  schemaCache = null;
  return getSchema();
}

export async function loadParquetBuffer(name, uint8) {
  await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await db.registerFileBuffer(`${name}`, uint8);
  await conn.query(
    `CREATE TABLE ${TABLE} AS SELECT * FROM read_parquet('${name}')`
  );
  schemaCache = null;
  return getSchema();
}

export async function getSchema() {
  if (schemaCache) return schemaCache;
  if (!(await tableExists())) return [];
  const res = await conn.query(`PRAGMA table_info('${TABLE}')`);
  schemaCache = res.toArray().map((r) => ({
    name: String(r.name),
    type: String(r.type),
  }));
  return schemaCache;
}

export async function tableExists() {
  try {
    const res = await conn.query(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = '${TABLE}'`
    );
    return Number(res.toArray()[0].n) > 0;
  } catch {
    return false;
  }
}

export async function columnNames() {
  return (await getSchema()).map((c) => c.name);
}

// ---- the read-only guardrail --------------------------------------------------

const FORBIDDEN = [
  // mutation / DDL
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE", "MERGE",
  "REPLACE", "GRANT", "REVOKE",
  // engine / io escape hatches
  "ATTACH", "DETACH", "COPY", "EXPORT", "IMPORT", "INSTALL", "LOAD", "PRAGMA",
  "SET", "CALL", "USE",
  // file & network readers
  "READ_CSV", "READ_CSV_AUTO", "READ_PARQUET", "READ_JSON", "READ_JSON_AUTO",
  "READ_TEXT", "READ_BLOB", "GLOB", "SNIFF_CSV",
];

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* block */
    .replace(/--[^\n]*/g, " ");         // -- line
}

/**
 * Returns { ok:true } or { ok:false, reason }. Enforces:
 *  single statement, must start with SELECT or WITH, no forbidden tokens,
 *  no file/network access, no external URLs.
 */
export function validateReadOnly(sql) {
  if (!sql || !sql.trim()) return { ok: false, reason: "Empty query." };
  const bare = stripComments(sql).trim();

  const statements = bare.split(";").map((s) => s.trim()).filter(Boolean);
  if (statements.length > 1) {
    return { ok: false, reason: "Only one statement is allowed." };
  }
  const stmt = statements[0] || "";
  const head = stmt.replace(/^\(+/, "").trimStart().toUpperCase();
  if (!(head.startsWith("SELECT") || head.startsWith("WITH"))) {
    return { ok: false, reason: "Only SELECT / WITH queries are allowed." };
  }
  const upper = stmt.toUpperCase();
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      return { ok: false, reason: `Disallowed keyword: ${kw}.` };
    }
  }
  if (/https?:\/\//i.test(stmt) || /\bs3:\/\//i.test(stmt)) {
    return { ok: false, reason: "External URLs are not allowed." };
  }
  return { ok: true };
}

// A lighter check for WHERE / boolean fragments (no leading SELECT expected).
export function validatePredicate(fragment) {
  if (fragment == null || fragment === "") return { ok: true };
  const bare = stripComments(String(fragment));
  if (bare.includes(";")) return { ok: false, reason: "No ';' in a filter." };
  const upper = bare.toUpperCase();
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      return { ok: false, reason: `Disallowed keyword in filter: ${kw}.` };
    }
  }
  if (/https?:\/\//i.test(bare)) return { ok: false, reason: "No URLs in a filter." };
  return { ok: true };
}

// ---- query execution ----------------------------------------------------------

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} exceeded ${ms} ms budget`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Serialize Arrow rows into plain JS, coercing BigInt so JSON.stringify is safe.
function rowsToPlain(table) {
  return table.toArray().map((row) => {
    const o = {};
    for (const [k, v] of Object.entries(row)) {
      o[k] = typeof v === "bigint" ? Number(v) : v;
    }
    return o;
  });
}

/**
 * Run validated read-only SQL. Caps rows at MAX_ROWS by wrapping the statement.
 * Returns { columns, rows, rowCount, truncated }.
 * NOTE: callers decide what (if anything) of this crosses to the agent.
 */
export async function runReadOnly(sql, { rowLimit = MAX_ROWS } = {}) {
  const check = validateReadOnly(sql);
  if (!check.ok) throw new Error(check.reason);
  const cap = Math.min(rowLimit, MAX_ROWS);
  const wrapped = `SELECT * FROM (\n${sql}\n) AS _q LIMIT ${cap + 1}`;
  const res = await withTimeout(conn.query(wrapped), QUERY_TIMEOUT_MS, "Query");
  let rows = rowsToPlain(res);
  const truncated = rows.length > cap;
  if (truncated) rows = rows.slice(0, cap);
  const columns = res.schema.fields.map((f) => f.name);
  return { columns, rows, rowCount: rows.length, truncated };
}

export async function rawQuery(sql) {
  // Internal use only (schema/aggregates the app itself builds). Not for agent SQL.
  const res = await withTimeout(conn.query(sql), QUERY_TIMEOUT_MS, "Query");
  return { columns: res.schema.fields.map((f) => f.name), rows: rowsToPlain(res) };
}
