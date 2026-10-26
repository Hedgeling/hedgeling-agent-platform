import { CONSOLE_ACTIONS, validateActionInput, ACTION_CONTRACT_VERSION } from "@hedgeling/api-contract";
import { consoleClientFromEnv } from "@hedgeling/platform-client";

export const consoleTools = CONSOLE_ACTIONS.map((action) => ({
  name: action.toolName, description: action.description, inputSchema: action.inputSchema,
  annotations: { readOnlyHint: action.readOnly, destructiveHint: false, idempotentHint: action.readOnly, openWorldHint: true },
}));

export async function callConsoleTool(name: string, input: unknown) {
  const action = CONSOLE_ACTIONS.find((candidate) => candidate.toolName === name);
  if (!action) return null;
  const invalid = validateActionInput(action, input);
  if (invalid) return { isError: true, content: [{ type: "text" as const, text: invalid }] };
  try {
    const client = consoleClientFromEnv();
    if ("error" in client) throw new Error(client.error);
    // Action scopes are explicit inputs; do not append the CLI's default project.
    const response = await client.request<{ version: number; action: string; result: unknown }>(
      "POST", `/api/actions/${action.name}`, input, { projectQuery: false },
    );
    if (response?.version !== ACTION_CONTRACT_VERSION || response.action !== action.name) {
      throw new Error("Unsupported console action response; check the console version");
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Console action failed" }] };
  }
}
