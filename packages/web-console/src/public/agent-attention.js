// Only semantic destinations owned by the console are addressable. Tool/model
// text never becomes a selector, script, URL, or click instruction.
const toolActions = Object.freeze({
  console_propose_job_quality_check: 'localization_job.review',
  console_get_job_quality_check: 'localization_job.review_status',
  console_propose_job_verification: 'localization_job.verify',
  console_propose_job_quality_cancel: 'localization_job.review_cancel',
  console_get_job_delivery_options: 'localization_job.delivery_options',
  console_propose_translation_pull_request: 'localization_job.pull_request',

  console_propose_context_enrichment: 'context.enrich', console_propose_context_apply: 'context.apply',
  console_list_string_context: 'read', console_list_context_runs: 'read', console_get_context_run: 'read',
  console_propose_translation_job_start: 'localization_job.start',
  console_propose_translation_job_cancel: 'localization_job.cancel',
  console_get_translation_job_status: 'localization_job.status',
  console_list_library: 'library.read', console_get_library_asset: 'library.read', console_read_library_sources: 'library.read', console_get_library_history: 'library.read',
  console_propose_translation_instructions: 'library.prompt.save', console_propose_locale_persona: 'library.persona.save', console_propose_glossary_term: 'library.glossary.save',
  console_propose_library_restore: 'library.restore', console_list_library_reviews: 'library.read', console_propose_library_review: 'library.review',
  console_get_project_locales: 'read',
  console_propose_project_locales: 'project.locales.add',
  console_list_source_connections: 'read',
  console_inspect_repository: 'extraction.start',
  console_list_repository_branches: 'extraction.start',
  console_read_repository_file: 'extraction.start',
  console_propose_repository_connection: 'repositories.connect',
  console_get_extraction_config: 'extraction.start',
  console_get_extraction_settings: 'extraction.start',
  console_propose_extraction_tuning: 'extraction.start',
  console_propose_tuning_apply: 'extraction.start',
  console_propose_extraction: 'extraction.start',
  console_list_extractions: 'read',
  console_get_extraction: 'read',
  console_propose_extraction_import: 'extraction.import',
  console_propose_organization: "organization.create",
  console_propose_business_unit: "business_unit.create",
  console_propose_project: "project.create",
  console_propose_localization_job: "localization_job.create",
  console_propose_organization_update: "organization.update",
  console_propose_business_unit_update: "business_unit.update",
  console_propose_project_update: "project.update",
  console_propose_localization_job_update: "localization_job.update",
  console_list_organizations: "read",
  console_get_workspace: "read",
  console_list_projects: "read",
  console_report_workspace: "read",
  console_report_jobs: "read",
  console_get_sync_status: "read",
  console_list_localization_jobs: "read",
});
const actions = new Set(Object.values(toolActions));
export function actionForTool(tool) { return Object.hasOwn(toolActions, tool) ? toolActions[tool] : null; }

export class AgentAttention {
  constructor() {
    this.nodes = new Set(); this.timer = null;
    this.status = document.createElement("div");
    this.status.className = "agent-attention-status sr-only";
    this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    document.body.append(this.status);
  }
  clear() {
    clearTimeout(this.timer);
    for (const node of this.nodes) { delete node.dataset.agentAttention; delete node.dataset.agentCaption; }
    this.nodes.clear(); this.status.textContent = "";
  }
  mark(node, label, phase = "working", duration = 6500) {
    if (!node?.isConnected || !node.getClientRects().length) return;
    node.dataset.agentAttention = phase; node.dataset.agentCaption = label; this.nodes.add(node);
    this.status.textContent = label;
    if (duration) { clearTimeout(this.timer); this.timer = setTimeout(() => this.clear(), duration); }
  }
  show({ action, resource, label, phase = "working", card } = {}) {
    if (!actions.has(action)) return;
    this.clear();
    const nav = document.getElementById(action.startsWith("library.") ? "libraryTab" : "workspaceTab");
    this.mark(nav, label, phase, 0);
    let target;
    if (action.startsWith('library.')) target = [...document.querySelectorAll('[data-library-kind]')].find(node => node.getClientRects().length)?.querySelector('.library-editor:not(:empty), .library-heading') || document.getElementById('libraryCards');
    if (!action.startsWith("library.") && resource && ["organization", "business_unit", "project", "job"].includes(resource.type)) {
      target = [...document.querySelectorAll("#workspaceRoot [data-resource-id]")].find((node) => node.dataset.resourceType === resource.type && node.dataset.resourceId === resource.id);
    }
    if (action === 'project.locales.add' && resource?.type === 'project') {
      const languages = [...document.querySelectorAll('#workspaceRoot .project-languages')].find(node => node.dataset.projectId === resource.id);
      target = languages?.querySelector('summary') || target;
    }
    if (!target && action !== "read") target = [...document.querySelectorAll("#workspaceRoot [data-workspace-action]")].find((node) => node.dataset.workspaceAction === action)?.querySelector("summary");
    if (!target && action === "read") target = document.querySelector("#workspaceRoot .workspace-heading");
    if (target?.getClientRects().length) target.scrollIntoView({ block: "nearest", behavior: "instant" });
    this.mark(target, label, phase, 0);
    this.mark(card, label, phase, 0);
    if (card?.isConnected) card.scrollIntoView({ block: "end", behavior: "instant" });
    if (phase !== "approval") this.timer = setTimeout(() => this.clear(), 6500);
  }
}
