import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { consoleTools, callConsoleTool } from "./consoleTools.js";

// This process only adapts the shared platform action contract. It has no
// workspace filesystem access, extraction engine, or human approval endpoint.
const server = new Server(
  { name: "hedgeling-platform-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: consoleTools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const result = await callConsoleTool(params.name, params.arguments ?? {});
  if (!result) throw new McpError(ErrorCode.InvalidParams, "Unknown platform tool");
  return result;
});
await server.connect(new StdioServerTransport());
