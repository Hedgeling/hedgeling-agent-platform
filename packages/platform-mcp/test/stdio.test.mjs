import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CONSOLE_ACTIONS } from "@hedgeling/api-contract";

test("standalone MCP discovers only platform tools and dispatches authenticated actions", async (t) => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, token: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: 1, action: "projects.list", result: { projects: [], page: { nextCursor: null } } }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: {
      HEDGELING_CONSOLE_URL: `http://127.0.0.1:${api.address().port}`,
      HEDGELING_CONSOLE_TOKEN: "synthetic-test-token",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "platform-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), CONSOLE_ACTIONS.map((action) => action.toolName));
  assert.ok(tools.every((tool) => !/process_file|confirm|approve/.test(tool.name)));
  assert.ok(tools.some(tool => tool.name === 'console_propose_extraction'));
  assert.ok(tools.some(tool => tool.name === 'console_propose_extraction_import'));
  assert.ok(tools.filter(tool => /extract/.test(tool.name)).every(tool => tool.name.startsWith('console_')));
  const result = await client.callTool({ name: "console_list_projects", arguments: { limit: 25 } });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).action, "projects.list");
  assert.deepEqual(requests, [{ url: "/api/actions/projects.list", token: "Bearer synthetic-test-token", body: { limit: 25 } }]);
  await assert.rejects(client.callTool({ name: "extract_and_translate", arguments: {} }), /Unknown platform tool/);
  const invalid = await client.callTool({ name: "console_list_projects", arguments: { actor: "admin" } });
  assert.equal(invalid.isError, true);
  assert.equal(requests.length, 1);
});
