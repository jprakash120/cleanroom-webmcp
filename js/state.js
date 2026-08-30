// state.js — the small shared surface between the UI (app.js) and the agent tools
// (tools.js). Keeping it separate avoids a circular import and gives us one place
// that knows "what is on screen right now": the active query, the last result, and
// which rows the human has selected.

let queryCounter = 0;

const state = {
  datasetName: null,
  activeSql: "",
  lastResult: null, // { queryId, columns, rows, rowCount, truncated }
  selection: new Set(), // indices into lastResult.rows
};

// UI hooks — app.js installs these so tools can drive the interface.
const hooks = {
  renderResult: () => {},
  download: () => {},
  focusSql: () => {},
};

export function installHooks(h) {
  Object.assign(hooks, h);
}

export function setDatasetName(name) {
  state.datasetName = name;
}
export function getDatasetName() {
  return state.datasetName;
}

export function nextQueryId() {
  return `q${++queryCounter}`;
}

export function setActiveSql(sql) {
  state.activeSql = sql || "";
}
export function getActiveSql() {
  return state.activeSql;
}

export function setLastResult(result) {
  state.lastResult = result;
  state.selection = new Set();
  hooks.renderResult(result);
}
export function getLastResult() {
  return state.lastResult;
}

export function setSelection(indices) {
  state.selection = new Set(indices);
}
export function toggleSelection(index) {
  if (state.selection.has(index)) state.selection.delete(index);
  else state.selection.add(index);
  return [...state.selection];
}
export function getSelectionIndices() {
  return [...state.selection];
}
export function getSelectedRows() {
  const r = state.lastResult;
  if (!r) return [];
  return [...state.selection].map((i) => r.rows[i]).filter(Boolean);
}

export function downloadFile(name, text, type = "application/json") {
  hooks.download(name, text, type);
}

export function focusSqlEditor(sql) {
  hooks.focusSql(sql);
}
