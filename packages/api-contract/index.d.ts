export const ACTION_CONTRACT_VERSION: 1;
export type ConsoleAction = {
  name: string; toolName: string; description: string;
  permission: string; scope: string; readOnly: boolean; consoleOnly?: boolean;
  inputSchema: { type: "object"; required?: string[]; additionalProperties: false; properties: Record<string, Record<string, unknown>>; anyOf?: { required: string[]; properties: Record<string, Record<string, unknown>> }[]; oneOf?: { required: string[]; properties: Record<string, Record<string, unknown>> }[] };
};
export const CONSOLE_ACTIONS: readonly ConsoleAction[];
export const REPORT_ACTIONS: readonly ConsoleAction[];
export const WORKSPACE_ACTIONS: readonly ConsoleAction[];
export function validateActionInput(action: ConsoleAction, input: unknown): string | null;
export function normalizeLibraryToolInput(toolName: string, input: unknown): unknown;

export const LOCALIZATION_WORKFLOWS: Readonly<Record<string, { label: string; steps: string[]; description: string }>>;
export const GUIDED_LOCALIZATION_SKILL: { id: string; version: number; actions: string[]; instructions: string };
