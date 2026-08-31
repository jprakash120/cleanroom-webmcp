// app.js â€” the human's side of the room.
//
// Boots DuckDB-WASM, registers the WebMCP tools, and renders the interface the
// analyst drives: file loading, SQL editor, results grid with row selection, the
// live disclosure log, and the hypothesis cards. It also installs the two hooks
// the tools depend on â€” how to draw a result, and how the disclosure gate asks
// the human for approval.

import {
  initDb,
  loadCsvText,
  loadCsvFile,
  loadParquetBuffer,
  rowCount,
  getSchema,
  columnNames,
} from "./db.js";
import * as privacy from "./privacy.js";
import * as hyp from "./hypotheses.js";
import * as ws from "./state.js";
import { TOOLS } from "./tools.js";
import {
  registerAll,
  webmcpStatus,
  requestUserAttention,
} from "./webmcp.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const SAMPLE_URL = "./data/production_runs.csv";
const EXAMPLES = [
  {
    label: "Attainment by shift",
    sql: "SELECT shift,\n       sum(actual_units) AS actual,\n       sum(planned_units) AS planned,\n       round(100.0*sum(actual_units)/sum(planned_units),1) AS attainment_pct\nFROM runs GROUP BY shift ORDER BY attainment_pct;",
  },
  {
    label: "Attainment by line & shift",
    sql: "SELECT line_id, shift,\n       round(100.0*sum(actual_units)/sum(planned_units),1) AS attainment_pct,\n       count(*) AS runs\nFROM runs GROUP BY line_id, shift ORDER BY attainment_pct;",
  },
  {
    label: "Downtime by reason",
    sql: "SELECT downtime_reason,\n       count(*) AS runs,\n       round(avg(downtime_min),1) AS avg_downtime_min\nFROM runs GROUP BY downtime_reason ORDER BY avg_downtime_min DESC;",
  },
  {
    label: "LINE-2 night shift detail",
    sql: "SELECT run_date, filler_pressure_psi, downtime_reason,\n       actual_units, planned_units, operator_id\nFROM runs\nWHERE line_id = 'LINE-2' AND shift = 'C'\nORDER BY run_date;",
  },
];

let currentColumns = [];
let revealSensitiveEnabled = false;
const pseudonyms = new Map();
let pseudonymCounter = 0;

// ---- boot ---------------------------------------------------------------------

async function boot() {
  wireStaticUi();
  reflectWebmcp();
  installHooks();
  wireSubscriptions();

  try {
    const threads = await initDb();
    setChip("chipEngine", "live", `DuckDB: ${threads}`);
  } catch (err) {
    setChip("chipEngine", "", "DuckDB: failed");
    console.error(err);
    toast("DuckDB failed to load. Check your connection and reload.");
    return;
  }

  const { registered, total } = registerAll(TOOLS);
  const status = webmcpStatus();
  setChip(
    "chipTools",
    status.available ? "live" : "",
    `tools: ${registered}/${total}`
  );
  renderToolPills(TOOLS.map((t) => t.name), status.available);
}

function reflectWebmcp() {
  const s = webmcpStatus();
  if (s.available) setChip("chipWebmcp", "live", `WebMCP: ${s.surface}`);
  else setChip("chipWebmcp", "warn", "WebMCP: no agent surface");
}

// ---- hooks the tools rely on --------------------------------------------------

function installHooks() {
  ws.installHooks({
    renderResult: renderGrid,
    download: (name, text, type = "application/json") => {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = el("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast(`Saved <b>${name}</b>`);
    },
    focusSql: (sql) => {
      $("sqlEditor").value = sql;
    },
  });

  // The disclosure gate: the agent's requestRows ends up here.
  privacy.setApprovalHandler(async (request) => {
    await requestUserAttention({ reason: "Disclosure approval needed" });
    return new Promise((resolve) => showApprovalModal(request, resolve));
  });
}

function wireSubscriptions() {
  privacy.subscribe((snap) => {
    renderLedger(snap.ledger);
    applySensitivity(snap.sensitive);
  });
  hyp.subscribe((cards) => renderHypotheses(cards));
}

// ---- static UI wiring ---------------------------------------------------------

function wireStaticUi() {
  $("btnSample").addEventListener("click", loadSample);
  $("btnUpload").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", onFilePicked);
  $("btnRun").addEventListener("click", runEditorSql);
  $("btnExport").addEventListener("click", async () => {
    const t = TOOLS.find((x) => x.name === "exportInvestigation");
    await t.execute({});
  });

  $("sqlEditor").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runEditorSql();
    }
  });

  const chips = $("exampleChips");
  EXAMPLES.forEach((ex) => {
    const c = el("button", "tool-pill", ex.label);
    c.style.cursor = "pointer";
    c.addEventListener("click", () => {
      $("sqlEditor").value = ex.sql;
      runEditorSql();
    });
    chips.appendChild(c);
  });
}

// ---- dataset loading ----------------------------------------------------------

async function loadSample() {
  try {
    const res = await fetch(SAMPLE_URL);
    if (!res.ok) throw new Error(`could not fetch sample (${res.status})`);
    const text = await res.text();
    await ingestCsv("production_runs.csv", text);
  } catch (err) {
    console.error(err);
    toast("Couldn't load the sample. Serve the folder over http (see README).");
  }
}

async function onFilePicked(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.name.toLowerCase().endsWith(".parquet")) {
      const buf = new Uint8Array(await file.arrayBuffer());
      await loadParquetBuffer(file.name, buf);
      await afterLoad(file.name, "parquet");
    } else {
      const { degraded } = await loadCsvFile(file);
      await afterLoad(file.name, "csv");
      if (degraded) {
        toast("Loaded as text â€” column types couldn't be inferred on this file.");
      }
    }
  } catch (err) {
    console.error(err);
    toast(`Could not read ${file.name}: ${err.message}`);
  } finally {
    e.target.value = "";
  }
}

async function ingestCsv(name, text) {
  await loadCsvText(name, text);
  await afterLoad(name, "csv");
}

async function afterLoad(name, kind) {
  ws.setDatasetName(name);
  currentColumns = await columnNames();
  privacy.resetSensitive(currentColumns);

  const n = await rowCount();
  $("datasetCard").hidden = false;
  $("dsName").textContent = name;
  $("dsMeta").textContent = `${n.toLocaleString()} rows Â· ${currentColumns.length} cols Â· ${kind}`;
  setChip("chipData", "live", name.length > 22 ? name.slice(0, 20) + "â€¦" : name);
  $("toolStatus").hidden = false;
  $("btnExport").hidden = false;

  await renderSchema();

  // Example chips only make sense for the sample schema; hide them otherwise.
  const isSampleSchema = ["shift", "line_id", "actual_units"].every((c) =>
    currentColumns.includes(c)
  );
  $("exampleChips").style.display = isSampleSchema ? "flex" : "none";

  // Prime the workspace with a first look that fits whatever was loaded.
  $("sqlEditor").value = isSampleSchema
    ? EXAMPLES[1].sql
    : "SELECT * FROM runs LIMIT 200;";
  await runEditorSql();
  toast(`<b>${name}</b> contained locally`);
}

// ---- schema list with sensitivity toggles -------------------------------------

async function renderSchema() {
  const schema = await getSchema();
  const list = $("schemaList");
  list.innerHTML = "";
  const head = el("div", "eyebrow");
  head.style.margin = "6px 0 8px";
  head.textContent = `Schema Â· ${schema.length} columns`;
  list.appendChild(head);

  schema.forEach((col) => {
    const row = el("div", "schema-row");
    row.dataset.col = col.name;
    row.appendChild(el("span", "cname", col.name));
    row.appendChild(el("span", "ctype", col.type.toLowerCase()));
    const t = el("button", "sens-toggle", "sensitive");
    t.addEventListener("click", () =>
      privacy.setSensitive(col.name, !privacy.isSensitive(col.name))
    );
    row.appendChild(t);
    list.appendChild(row);
  });
  applySensitivity(privacy.getSensitiveColumns());
}

function applySensitivity(sensitiveList) {
  const set = new Set(sensitiveList);
  document.querySelectorAll(".schema-row").forEach((row) => {
    const on = set.has(row.dataset.col);
    const toggle = row.querySelector(".sens-toggle");
    if (toggle) toggle.classList.toggle("on", on);
  });
  // Reflect on any rendered grid headers/cells.
  document.querySelectorAll("table.grid th[data-col]").forEach((th) => {
    th.classList.toggle("sensitive", set.has(th.dataset.col));
  });
  document.querySelectorAll("table.grid td[data-col]").forEach((td) => {
    td.classList.toggle("sensitive", set.has(td.dataset.col));
  });
}

// ---- SQL execution (human) ----------------------------------------------------

async function runEditorSql() {
  const sql = $("sqlEditor").value.trim();
  if (!sql) return;
  const t = TOOLS.find((x) => x.name === "executeLocalQuery");
  try {
    // Routes through the same tool the agent uses, so the human and agent paths
    // stay identical.
    await t.execute({ sql });
  } catch (err) {
    toast(escapeHtml(err.message || "Query error"));
  }
}

// ---- results grid + selection -------------------------------------------------

function renderGrid(result) {
  const scroll = $("gridScroll");
  scroll.innerHTML = "";
  if (!result || result.rows.length === 0) {
    const e = el("div", "empty");
    e.innerHTML = `<div><div class="big">No rows</div><div>This query returned nothing.</div></div>`;
    scroll.appendChild(e);
    updateResultMeta(result);
    return;
  }
  const hasSensitiveCol = result.columns.some((c) => privacy.isSensitive(c));
  if (hasSensitiveCol) {
    const controls = el("div", "grid-controls");
    const label = el("label", "reveal-toggle");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = revealSensitiveEnabled;
    cb.addEventListener("change", () => {
      revealSensitiveEnabled = cb.checked;
      renderGrid(ws.getLastResult());
    });
    label.appendChild(cb);
    label.appendChild(
      document.createTextNode(
        " Reveal sensitive values (local only — never sent to the agent)"
      )
    );
    controls.appendChild(label);
    scroll.appendChild(controls);
  }

  const table = el("table", "grid");
  const thead = el("thead");
  const htr = el("tr");
  result.columns.forEach((c) => {
    const th = el("th", null, c);
    th.dataset.col = c;
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el("tbody");
  result.rows.forEach((row, i) => {
    const tr = el("tr");
    tr.dataset.index = i;
    result.columns.forEach((c) => {
      const td = el("td", null, cellDisplayValue(c, row[c]));
      td.dataset.col = c;
      tr.appendChild(td);
    });
    tr.addEventListener("click", () => toggleRow(i, tr));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);

  applySensitivity(privacy.getSensitiveColumns());
  updateResultMeta(result);
}

function toggleRow(index, tr) {
  const selected = ws.toggleSelection(index);
  tr.classList.toggle("selected", selected.includes(index));
  updateResultMeta(ws.getLastResult());
}

function updateResultMeta(result) {
  const meta = $("resultMeta");
  if (!result) {
    meta.innerHTML = "";
    return;
  }
  const sel = ws.getSelectionIndices().length;
  const parts = [
    `<span class="hot">${result.rowCount}</span> rows shown`,
    result.truncated ? `<span class="warn">capped at ${result.rowCount}</span>` : "",
    sel ? `<span class="hot">${sel}</span> selected` : `click rows to select`,
    `query <span class="hot">${result.queryId || "â€”"}</span>`,
  ].filter(Boolean);
  meta.innerHTML = parts.join(" &nbsp;Â·&nbsp; ");
}

function pseudonymFor(rawValue) {
  const key = String(rawValue);
  if (!pseudonyms.has(key)) {
    const letter = String.fromCharCode(65 + (pseudonymCounter % 26));
    pseudonymCounter += 1;
    pseudonyms.set(key, `Value ${letter}`);
  }
  return pseudonyms.get(key);
}

function cellDisplayValue(col, raw) {
  // Sensitive columns never render their real value in the shared grid
  // unless the analyst has locally enabled reveal.
  if (privacy.isSensitive(col) && !revealSensitiveEnabled) {
    return raw === null || raw === undefined ? String.fromCharCode(0x2205) : pseudonymFor(raw);
  }
  return formatCell(raw);
}
function formatCell(v) {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toLocaleString() : String(v);
  }
  return String(v);
}

// ---- disclosure log -----------------------------------------------------------

function renderLedger(ledger) {
  const wrap = $("ledger");
  const disclosures = ledger.filter((e) => e.kind !== "metadata");
  $("tallyAgg").textContent = ledger.filter((e) => e.kind === "aggregate").length;
  $("tallyRaw").textContent = ledger.filter((e) => e.kind === "raw").length;
  $("tallyDenied").textContent = ledger.filter((e) => e.kind === "denied").length;

  wrap.innerHTML = "";
  if (ledger.length === 0) {
    wrap.appendChild(elNote("Nothing has crossed the boundary yet."));
    return;
  }
  // Newest first, metadata included but visually dimmed.
  [...ledger].reverse().forEach((e) => {
    const card = el("div", `ledger-entry kind-${e.kind}`);
    const head = el("div", "le-head");
    head.appendChild(el("span", "le-kind", labelFor(e.kind)));
    head.appendChild(el("span", "le-time", timeOf(e.at)));
    card.appendChild(head);
    card.appendChild(el("div", "le-summary", e.summary));
    wrap.appendChild(card);
  });
}

function labelFor(kind) {
  return {
    aggregate: "aggregate",
    raw: "raw rows",
    denied: "denied",
    metadata: "metadata",
  }[kind] || kind;
}

// ---- hypotheses ---------------------------------------------------------------

function renderHypotheses(cards) {
  const wrap = $("hypList");
  wrap.innerHTML = "";
  if (cards.length === 0) {
    wrap.appendChild(
      elNote("The agent's hypotheses and your corrections will appear here.")
    );
    return;
  }
  cards.forEach((c) => wrap.appendChild(hypothesisCard(c)));
}

function hypothesisCard(c) {
  const card = el("div", "hyp-card");
  const top = el("div", "hc-top");
  top.appendChild(el("span", `hstatus ${c.status}`, c.status));
  top.appendChild(el("span", "hc-author", c.author));
  card.appendChild(top);

  card.appendChild(el("div", "hc-statement", c.statement));

  if (c.confidence != null) {
    const conf = el("div", "hc-conf");
    const bar = el("div", "conf-bar");
    const span = el("span");
    span.style.width = `${Math.round(c.confidence * 100)}%`;
    if (c.status === "rejected") span.style.background = "var(--rejected)";
    bar.appendChild(span);
    conf.appendChild(bar);
    conf.appendChild(el("div", "clabel", `confidence ${Math.round(c.confidence * 100)}%`));
    card.appendChild(conf);
  }

  if (c.evidence.length) {
    const ev = el("div", "hc-evidence");
    c.evidence.forEach((e) => {
      const row = el("div", `ev ${e.stance}`);
      row.appendChild(document.createTextNode(e.note));
      if (e.sql) {
        const code = el("code", null, e.sql);
        row.appendChild(code);
      }
      ev.appendChild(row);
    });
    card.appendChild(ev);
  }

  if (c.correction) {
    const corr = el("div", "hc-correction");
    corr.innerHTML = `<b>Analyst correction:</b> ${escapeHtml(c.correction)}`;
    card.appendChild(corr);
  }
  return card;
}

// ---- small helpers ------------------------------------------------------------

function elNote(text) {
  return el("div", "side-note", text);
}
function timeOf(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}
function setChip(id, cls, text) {
  const chip = $(id);
  chip.className = `chip ${cls || ""}`.trim();
  const dot = el("span", "dot");
  chip.innerHTML = "";
  chip.appendChild(dot);
  chip.appendChild(document.createTextNode(text));
}
function renderToolPills(names, available) {
  const wrap = $("toolPills");
  wrap.innerHTML = "";
  names.forEach((n) => {
    const p = el("span", "tool-pill", n);
    if (!available) p.style.opacity = "0.55";
    wrap.appendChild(p);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---- the disclosure approval modal (the gate) ---------------------------------

function showApprovalModal(request, resolve) {
  const root = $("modalRoot");
  const scrim = el("div", "modal-scrim");
  const modal = el("div", "modal");

  const done = (approved) => {
    document.removeEventListener("keydown", onKey);
    scrim.remove();
    resolve(approved);
  };
  const onKey = (e) => {
    if (e.key === "Escape") done(false);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) done(true);
  };
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) done(false);
  });

  const hasSensitive = request.sensitiveColumns.length > 0;

  modal.innerHTML = `
    <div class="m-head">
      <div class="m-title"><span class="boundary-icon"></span> Disclosure request</div>
      <div class="m-sub">The agent is asking to receive raw records. Nothing is shared unless you approve.</div>
    </div>
    <div class="m-body">
      <div class="reason-quote">"${escapeHtml(request.reason)}"</div>
      <div class="disclosure-line"><span class="k">rows to share</span><span class="v mono">${request.rowCount}</span></div>
      <div class="disclosure-line"><span class="k">columns</span><span class="v mono">${request.columns.map(escapeHtml).join(", ")}</span></div>
      ${
        hasSensitive
          ? `<div class="sensitive-warn"><span>â–²</span><div><b>Sensitive columns included.</b> This request contains<span class="chip-list">${request.sensitiveColumns
              .map((s) => `<span class="s">${escapeHtml(s)}</span>`)
              .join("")}</span> â€” individual-level data that will leave the browser if approved.</div></div>`
          : ""
      }
      ${
        request.belowKAnon
          ? `<div class="sensitive-warn" style="margin-top:8px;"><span>â–²</span><div>Fewer than <b>${privacy.K_ANON}</b> rows â€” a set this small can identify individuals. Consider an aggregate instead.</div></div>`
          : ""
      }
    </div>
    <div class="m-actions">
      <button class="btn deny" id="mDeny">Deny</button>
      <button class="btn approve" id="mApprove">Approve disclosure</button>
    </div>
  `;

  scrim.appendChild(modal);
  root.appendChild(scrim);
  modal.querySelector("#mDeny").addEventListener("click", () => done(false));
  modal.querySelector("#mApprove").addEventListener("click", () => done(true));
  modal.querySelector("#mApprove").focus();
}

// ---- toasts -------------------------------------------------------------------

function toast(html) {
  const wrap = $("toastWrap");
  const t = el("div", "toast");
  t.innerHTML = html;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .3s";
    setTimeout(() => t.remove(), 320);
  }, 2600);
}

boot();
