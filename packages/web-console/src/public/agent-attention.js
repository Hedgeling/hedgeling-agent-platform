// Only semantic destinations owned by the console are addressable. Tool/model
// text never becomes a selector, script, URL, or click instruction.
const toolActions = Object.freeze({
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
    const nav = document.getElementById("workspaceTab");
    this.mark(nav, label, phase, 0);
    let target;
    if (resource && ["organization", "business_unit", "project", "job"].includes(resource.type)) {
      target = [...document.querySelectorAll("#workspaceRoot [data-resource-id]")].find((node) => node.dataset.resourceType === resource.type && node.dataset.resourceId === resource.id);
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
