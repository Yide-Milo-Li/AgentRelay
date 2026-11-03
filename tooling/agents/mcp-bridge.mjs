// A local stdio MCP bridge for agents that cannot reach `/api/agent/mcp` directly: they only run local servers, or
// cannot send the custom headers. It forwards each JSON-RPC message to the Site and adds the Agent Token, plus the
// Sites gateway token when the Site has one.
// The Site stays the only MCP implementation; this file never interprets a tool call, and it never logs a credential.

const REQUEST_TIMEOUT_MS = 120_000;
const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, BRIDGE_ERROR = -32000;

const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// The JSON Schema subset some clients enforce on tool parameters (DeepSeek Harness rejects every tool of a server
// when one schema uses anything else). Bounds outside it stay enforced by the Site.
const CORE_SCHEMA_KEYWORDS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"]);

/** Reduce a tool's input schema to the core subset, keeping each dropped constraint readable in the description. */
export function coreToolSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const result = {}, dropped = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!CORE_SCHEMA_KEYWORDS.has(key)) { if (value === null || typeof value !== "object") dropped.push(`${key} ${value}`); continue; }
    if (key === "properties" && value && typeof value === "object") result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, coreToolSchema(child)]));
    else if (key === "items") result.items = coreToolSchema(value);
    else if (key === "oneOf" && Array.isArray(value)) result.oneOf = value.map(coreToolSchema);
    else result[key] = value;
  }
  if (dropped.length) result.description = [result.description, `(${dropped.join(", ")})`].filter(Boolean).join(" ");
  return result;
}

/** What the person at the keyboard should do about each refusal. The response body is never echoed. */
function refusal(status) {
  if (status === 401) return "AgentRelay refused the credentials (401). Check that AGENTRELAY_AGENT_TOKEN is current and that AGENTRELAY_SITES_GATEWAY_TOKEN belongs to this Site.";
  if (status === 403) return "AgentRelay refused the request (403).";
  if (status === 413) return "AgentRelay refused the request because it is too large (413).";
  return null;
}

/**
 * @param {object} options
 * @param {string} options.endpoint The Site's `/api/agent/mcp` URL.
 * @param {string} options.agentToken
 * @param {string | null} [options.gatewayToken] The Sites gateway token; null for a deployment without that gate.
 * @param {(message: object) => void} options.write Receives every message for the client, already parsed.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {boolean} [options.coreSchemas] Reduce `tools/list` input schemas to the core subset, for clients that enforce it.
 * @param {boolean} [options.initializeOnly] Refuse `server/discover` locally so the client's SDK falls back to `initialize`.
 *   Sites deployed before the Agent endpoint stopped answering discovery advertise Sites' own stateless era there,
 *   which such SDKs then try and abandon after `tools/list`; current Sites already refuse it, so this is a no-op there.
 */
export function createBridge({ endpoint, agentToken, gatewayToken, write, fetchImpl = fetch, coreSchemas = false, initializeOnly = false }) {
  const inflight = new Set();

  async function forward(message, expectsReply) {
    const id = message.id ?? null;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${agentToken}`, ...(gatewayToken ? { "OAI-Sites-Authorization": `Bearer ${gatewayToken}` } : {}),
        },
        body: JSON.stringify(message),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (expectsReply) write(failure(id, BRIDGE_ERROR, `Cannot reach the AgentRelay site (${error?.cause?.code ?? error?.name ?? "network error"}).`));
      return;
    }
    if (!expectsReply) return;
    const text = await response.text();
    const refused = refusal(response.status);
    if (refused) return write(failure(id, BRIDGE_ERROR, refused));
    let reply;
    try { reply = JSON.parse(text); } catch { /* A restricted site answers a wrong gateway token with an HTML page. */ }
    if (!reply || typeof reply !== "object") {
      return write(failure(id, BRIDGE_ERROR, `AgentRelay answered ${response.status} without MCP data. Check the endpoint URL and the Sites gateway token.`));
    }
    if (coreSchemas && message.method === "tools/list" && Array.isArray(reply.result?.tools)) {
      reply = { ...reply, result: { ...reply.result, tools: reply.result.tools.map(tool => ({ ...tool, inputSchema: coreToolSchema(tool.inputSchema) })) } };
    }
    write(reply);
  }

  /** Handle one line of client input. Resolves when its reply, if any, has been written. */
  function handle(line) {
    const task = (async () => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return write(failure(null, PARSE_ERROR, "Parse error: each line must be one JSON-RPC message.")); }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return write(failure(null, INVALID_REQUEST, "Invalid request: send one JSON-RPC message per line, not a batch."));
      }
      // A message without a method is a client reply to a server request; AgentRelay never sends any.
      if (typeof message.method !== "string") return;
      if (initializeOnly && message.method === "server/discover") {
        if (message.id !== undefined) write(failure(message.id, METHOD_NOT_FOUND, "Method not found"));
        return;
      }
      await forward(message, message.id !== undefined);
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
    return task;
  }

  return { handle, idle: async () => { while (inflight.size) await Promise.allSettled([...inflight]); } };
}
