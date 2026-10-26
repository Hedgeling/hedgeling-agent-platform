import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CONSOLE_ACTIONS } from "@hedgeling/api-contract";
import { invokeConsoleAction } from "./actions.js";

// One process-local MCP session per turn. It carries trusted delegated
// identity, never browser cookies, user-provided identity flags or API keys.
export async function connectAgentTools(auth, context, guard) {
  const actions = CONSOLE_ACTIONS.filter((action) => action.name !== "organization.create" || process.env.HEDGELING_AGENT_ORG_CREATION_ENABLED === "true").filter((action) => context.organizationId
    ? action.name !== "organization.create"
    : ["organization.create", "organizations.list"].includes(action.name));
  const tools = actions.map((action) => ({ name: action.toolName, description: action.description, inputSchema: action.inputSchema,
    annotations: { readOnlyHint: action.readOnly, destructiveHint: false, openWorldHint: false } }));
  const server = new Server({ name: "hedgeling-console", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await guard();
    const action = actions.find((a) => a.toolName === request.params.name);
    if (!action) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "This tool is unavailable in the current scope", code: "tool_unavailable" }) }] };
    try {
      const result = await invokeConsoleAction(action.name, request.params.arguments || {}, auth, context);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.status && error.status < 500 ? error.message : "The action could not be completed", code: error.code || "action_failed" }) }] };
    }
  });
  const client = new Client({ name: "hedgeling-assistant", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { tools, client, close: async () => { await client.close(); await server.close(); } };
}
