// SPDX-License-Identifier: Apache-2.0
const projectSlug = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const define = (name, toolName, description, permission, properties, readOnly) => ({ name, toolName, description, permission,
  scope: 'agent_domain', readOnly, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });
export const PROJECT_LOCALE_ACTIONS = Object.freeze([
  define('project.locales.get', 'console_get_project_locales', 'Read a discovered project’s source language, enabled target locales, disabled locales you may view, and whether you can manage languages. Hidden locales are omitted.', 'locales.view', { projectSlug }, true),
  define('project.locales.add', 'console_propose_project_locales', 'Preview adding target locales to an existing project. Supply only additions, not a replacement list. Canonical BCP 47 codes (such as fr-CA or pt-BR), maximum 30 per request. Existing targets are preserved; disabled requested locales are re-enabled. Source language, jobs and translations are unchanged. Human confirmation is required; no translation or spending starts.', 'locales.manage', {
    projectSlug, targetLocales: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: { type: 'string', minLength: 2, maxLength: 100 } },
  }, false),
]);
export const PROJECT_LOCALE_SKILL = { id: 'project-languages', version: 1, actions: ['projects.list', ...PROJECT_LOCALE_ACTIONS.map(a => a.name)],
  instructions: 'For a request to add project languages, discover the project first and call project.locales.get. Ask which project if ambiguous. Use BCP 47 locale codes; clarify regional variants when the request is ambiguous instead of guessing. Propose only the requested additions with project.locales.add, then wait for the person’s confirmation. Existing enabled targets are preserved and requested disabled targets are re-enabled. The source locale cannot be a target. This does not change existing job selections or start translation; a separate job or translation action is needed. Explain a plan limit or permission error without bypassing it. Removing locales, changing source language and deleting translations are not supported by this tool.' };
