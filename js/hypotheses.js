// hypotheses.js — the reproducible investigation record.
//
// Instead of the agent emitting a one-shot answer that vanishes into chat, every
// claim becomes a visible card: the hypothesis, the evidence for and against, the
// exact SQL that produced that evidence, a confidence, and a status the human
// controls (open / supported / rejected). The whole thing exports to a report
// where each conclusion can be reproduced from its query.

const cards = [];
let seq = 0;
const subscribers = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  fn(list());
  return () => subscribers.delete(fn);
}
function emit() {
  const snap = list();
  subscribers.forEach((fn) => fn(snap));
}
export function list() {
  return cards.map((c) => ({ ...c, evidence: [...c.evidence] }));
}
export function get(id) {
  return cards.find((c) => c.id === id) || null;
}

const STATUSES = new Set(["open", "supported", "rejected"]);

/**
 * @param {Object} h
 * @param {string} h.statement        the hypothesis, in plain language
 * @param {number} [h.confidence]     0..1
 * @param {string} [h.author]         'agent' | 'analyst'
 */
export function addHypothesis(h) {
  if (!h || !h.statement) throw new Error("A hypothesis needs a statement.");
  const card = {
    id: ++seq,
    statement: String(h.statement),
    status: "open",
    confidence: clamp01(h.confidence),
    author: h.author === "analyst" ? "analyst" : "agent",
    createdAt: new Date().toISOString(),
    evidence: [],
    correction: null,
  };
  cards.push(card);
  emit();
  return publicView(card);
}

/**
 * @param {Object} u
 * @param {number} u.id
 * @param {string} [u.status]                       open|supported|rejected
 * @param {number} [u.confidence]
 * @param {string} [u.correction]                   analyst's note that overrides
 * @param {{stance:'support'|'conflict', note:string, sql?:string}} [u.evidence]
 */
export function updateHypothesis(u) {
  const card = get(u.id);
  if (!card) throw new Error(`No hypothesis with id ${u.id}`);

  if (u.status !== undefined) {
    if (!STATUSES.has(u.status)) throw new Error(`Bad status: ${u.status}`);
    card.status = u.status;
  }
  if (u.confidence !== undefined) card.confidence = clamp01(u.confidence);
  if (u.correction !== undefined) card.correction = String(u.correction);
  if (u.evidence) {
    const e = u.evidence;
    const stance = e.stance === "conflict" ? "conflict" : "support";
    card.evidence.push({
      stance,
      note: String(e.note || ""),
      sql: e.sql ? String(e.sql) : null,
      at: new Date().toISOString(),
    });
  }
  card.updatedAt = new Date().toISOString();
  emit();
  return publicView(card);
}

export function pinnedFindings() {
  return cards.filter((c) => c.status === "supported").map(publicView);
}

function publicView(card) {
  return { ...card, evidence: [...card.evidence] };
}
function clamp01(v) {
  if (v === undefined || v === null || Number.isNaN(Number(v))) return null;
  return Math.max(0, Math.min(1, Number(v)));
}
