// webmcp.js — a thin compatibility layer over the WebMCP browser API.
//
// Why this file exists: WebMCP is a moving W3C draft. Across 2026 the surface
// has changed more than once, and different agent hosts (ChatGPT's built-in
// browser, Chrome behind the Experimental Web Platform Features flag) may expose
// slightly different versions at any given moment. The known variations:
//
//   * getter location : navigator.modelContext (original) has been superseded by
//                        document.modelContext in later drafts. Both may exist.
//   * callback name   : the tool's function is called `execute` in some drafts
//                        and `handler` in others.
//   * return shape    : agents accept an MCP-style result
//                        { content: [{ type:"text", text }], structuredContent }.
//
// Rather than bet on one spelling, we detect what's present and register tools
// under every shape the host might read. Everything in the rest of the app talks
// to THIS module, never to the raw API, so if the spec shifts again only this
// file changes.
//
// No native support (e.g. a plain browser tab with no agent)? The app still runs
// fully for the human; tools just aren't exposed. For non-Chromium testing you
// can load the @mcp-b/global polyfill before this script.

const container = () =>
  (typeof document !== "undefined" && document.modelContext) ||
  (typeof navigator !== "undefined" && navigator.modelContext) ||
  null;

export function webmcpStatus() {
  const mc = container();
  if (!mc) return { available: false, surface: null };
  const surface =
    typeof document !== "undefined" && document.modelContext
      ? "document.modelContext"
      : "navigator.modelContext";
  return { available: true, surface };
}

// Normalize whatever a tool returns into an MCP tool result the agent can read.
function toToolResult(value) {
  // Already in MCP result shape — pass through.
  if (value && Array.isArray(value.content)) return value;

  const structured = value === undefined ? {} : value;
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(structured);
  } catch {
    text = String(value);
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

const registered = new Map(); // name -> definition, so we can re-register / clean up

/**
 * Register one tool with the browser's agent surface.
 * @param {Object} def
 * @param {string} def.name
 * @param {string} def.description
 * @param {Object} def.inputSchema  JSON Schema for the arguments
 * @param {Function} def.execute    async (args) => result   (any return shape ok)
 */
export function registerTool(def) {
  const mc = container();
  registered.set(def.name, def);
  if (!mc || typeof mc.registerTool !== "function") return false;

  const wrapped = async (args) => {
    try {
      const out = await def.execute(args || {});
      return toToolResult(out);
    } catch (err) {
      // Surface a structured error rather than throwing — the agent shows it.
      return toToolResult({
        error: true,
        message: err && err.message ? err.message : String(err),
      });
    }
  };

  // Provide BOTH callback names; hosts read whichever they know.
  const payload = {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema || { type: "object", properties: {} },
    execute: wrapped,
    handler: wrapped,
  };

  try {
    mc.registerTool(payload);
    return true;
  } catch (err) {
    console.warn(`[webmcp] registerTool failed for "${def.name}":`, err);
    return false;
  }
}

export function registerAll(defs) {
  let ok = 0;
  for (const d of defs) if (registerTool(d)) ok += 1;
  return { registered: ok, total: defs.length };
}

export function registeredToolNames() {
  return [...registered.keys()];
}

// Best-effort: ask the host to bring the page forward before showing UI during a
// tool call. Optional in the spec; guarded so its absence never breaks a call.
export async function requestUserAttention(options = {}) {
  const mc = container();
  if (mc && typeof mc.requestUserInteraction === "function") {
    try {
      await mc.requestUserInteraction(options);
    } catch {
      /* non-fatal */
    }
  }
}
