import { CHAT_LIMITS } from './chat-limits.js';
import { projectLanguages } from './project-locales.js';
import { extractionPanel } from './extraction.js';
export async function request(path, body) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || "The request could not be completed"), { status: response.status, code: data.code });
  return data;
}
export function element(tag, className = "", text = "") {
  const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node;
}
export const actionLabel = { "organization.create": "Create organization", "business_unit.create": "Create business unit", "project.create": "Create project", "localization_job.create": "Create job draft", "organization.update": "Save organization name", "business_unit.update": "Save business-unit name", "project.update": "Save project name", "localization_job.update": "Save job changes" };
const workflowLabels = { machine_translation: "AI translation", human_translation: "Human translation", review: "Review", qa: "Quality check" };
Object.assign(actionLabel, { 'project.locales.add': 'Add target languages', 'extraction.tune': 'Run tuning preview', 'extraction.tuning.apply': 'Save settings and re-extract', 'extraction.start': 'Start extraction', 'extraction.import': 'Import source strings' });
Object.assign(actionLabel, { 'library.prompt.save': 'Save instructions', 'library.persona.save': 'Save persona', 'library.glossary.save': 'Save term', 'library.restore': 'Restore revision', 'library.review': 'Confirm review' });
const proposalLabel = preview => preview.library?.disposition === 'submit' ? 'Submit suggestion' : preview.library?.disposition === 'reject' ? 'Reject suggestion' : preview.library?.disposition === 'approve' ? 'Approve suggestion' : actionLabel[preview.action];
const displayField = (key, value) => typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.map((v) => key === "steps" ? workflowLabels[v] || v : v).join(key === "steps" ? " → " : ", ") : value && typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "—");
export function proposalCard(proposal, confirm, reject, { example = false, edit = null } = {}) {
  const card = element("article", "agent-proposal"); card.dataset.proposalId = proposal.id;
  const heading = element("div", "agent-card-heading");
  heading.append(element("span", "agent-eyebrow", example ? "EXAMPLE · APPROVAL CARD" : "HERE’S THE PLAN"), element("span", "agent-stamp", "Your call"));
  card.append(heading, element("h3", "", proposalLabel(proposal.preview) || "Review change"));
  appendProposalDetails(card, proposal.preview);
  card.append(element("p", "agent-card-help", example ? "Give it a try—this is just a preview. Your workspace stays as it is." : proposal.preview.action.startsWith('extraction.') ? 'Ready to go? Confirm this step below. Want to change the selection? Discard it and tell me what to adjust.' : proposal.preview.changes ? "Happy with these changes? Save them when you’re ready. Want a tweak? Discard this preview and tell me what to adjust." : "Looks good? Create it when you’re ready. Want a tweak? Choose Discard, then tell me what to change and I’ll prepare a fresh preview."));
  const actions = element("div", "agent-card-actions");
  const yes = element("button", "primary", proposalLabel(proposal.preview) || "Confirm change"); yes.type = "button";
  const no = element("button", "", "Discard"); no.type = "button";
  const error = element("p", "agent-error"); error.setAttribute("role", "alert");
  for (const [button, handler] of [[yes, confirm], [no, reject]]) button.addEventListener("click", async () => {
    yes.disabled = no.disabled = true; error.textContent = "";
    try { await handler(proposal); card.replaceChildren(element("p", "agent-receipt", example ? (button === yes ? "Preview approved. No workspace changes were made." : "Preview discarded.") : (button === yes ? "Change confirmed." : "Proposal discarded."))); }
    catch (e) { error.textContent = e.message; yes.disabled = no.disabled = false; }
  });
  if (edit && proposal.preview.action.startsWith('library.') && proposal.preview.action.endsWith('.save')) {
    const change = element('button', '', 'Edit in Library'); change.type='button';
    change.addEventListener('click', async () => { yes.disabled=no.disabled=change.disabled=true;error.textContent='';try{await edit(proposal);card.replaceChildren(element('p','agent-receipt','Preview discarded. Edit the draft in Library, then review it again.'));}catch(e){error.textContent=e.message;yes.disabled=no.disabled=change.disabled=false;} });
    actions.append(change);
  }
  actions.append(yes, no); card.append(actions, error); return card;
}

// Share the server's immutable facts, while each surface owns its presentation
// and interaction: chat replies versus a manual form's review step.
function appendProposalDetails(card, preview) {
  const fields = element("dl", "agent-fields");
  const labels = { name: "Name", sourceLocale: "Source language", targetLocales: "Target languages", steps: "Workflow", repository: 'Repository', ref: 'Source revision', scanRoots: 'Source paths', commitSha: 'Pinned commit', settings: 'Extraction settings' };
  for (const [key, label] of preview.changes ? Object.entries(labels).filter(([key]) => ['commitSha', 'scanRoots'].includes(key)) : Object.entries(labels)) {
    const value = preview.fields[key];
    if (value !== undefined) fields.append(element("dt", "", label), element("dd", "", displayField(key, value)));
  }
  const resources = preview.resources;
  const scope = resources.organization?.name || resources.businessUnit?.name || resources.project?.name;
  if (scope) fields.append(element("dt", "", "In"), element("dd", "", scope));
  if (resources.sourceCount !== undefined) fields.append(element("dt", "", "Source content"), element("dd", "", `${resources.sourceCount} strings`));
  if (preview.library) {
    fields.append(element('dt','','Library asset'),element('dd','',preview.library.label),element('dt','','Language'),element('dd','',preview.library.locale || 'Project-wide'),element('dt','','On confirmation'),element('dd','',preview.library.disposition === 'submit' ? 'Submit for review; keep active guidance unchanged' : preview.library.disposition === 'reject' ? 'Reject this suggestion' : 'Save this guidance'));
  }
  card.append(fields);
  if (preview.changes) for (const change of preview.changes) {
    const section = element("section", "agent-change"); section.append(element("h4", "", change.label));
    const values = element("dl", "agent-change-values");
    values.append(element("dt", "", "Current"), element("dd", "", displayField(change.field, change.before)), element("dt", "", ["submit","reject"].includes(preview.library?.disposition) ? "Suggested" : "After"), element("dd", "agent-change-after", displayField(change.field, change.after)));
    section.append(values); card.append(section);
  }
  if (preview.cost) card.append(element("p", "agent-cost-note", preview.cost));
  const effects = element("ul", "agent-effects");
  for (const item of preview.sideEffects || []) effects.append(element("li", "", item));
  card.append(effects);
}

export function workspaceConfirmation(proposal, { confirm, edit, cancel }) {
  const card = element("section", "workspace-confirmation"); card.dataset.proposalId = proposal.id;
  const updating = Boolean(proposal.preview.changes);
  const title = element("h3", "", updating ? "Review changes" : "Review details");
  title.id = `workspace-review-${proposal.id}`; title.tabIndex = -1; card.setAttribute("aria-labelledby", title.id);
  card.append(element("p", "workspace-confirmation-step", "REVIEW & CONFIRM"), title,
    element("p", "workspace-confirmation-help", proposal.preview.action.startsWith('extraction.') ? 'Review this step before confirming. Use Edit details to return without starting it.' : updating ? "Check the changes below before saving. Choose Edit details to return to the form." : "Check the details below before creating this item. Choose Edit details to return to the form."));
  appendProposalDetails(card, proposal.preview);
  const actions = element("div", "workspace-confirmation-actions");
  const back = element("button", "", "Edit details"), dismiss = element("button", "", "Cancel");
  const save = element("button", "primary", proposalLabel(proposal.preview) || "Save changes");
  const buttons = [back, dismiss, save];
  const error = element("p", "agent-error"); error.setAttribute("role", "alert");
  for (const [button, handler] of [[back, edit], [dismiss, cancel], [save, confirm]]) {
    button.type = "button";
    button.addEventListener("click", async () => {
      buttons.forEach((control) => { control.disabled = true; }); error.textContent = "";
      try { await handler(proposal); }
      catch (e) { error.textContent = e.message; buttons.forEach((control) => { control.disabled = false; }); }
    });
  }
  actions.append(...buttons); card.append(actions, error); return card;
}

// Answer cards collect details; only the separate confirmation controls approve writes.
export function answerCard({ title, description, fields, submitLabel = "Send answer", example = false }, onAnswer) {
  const card = element("article", "agent-answer-card");
  card.append(element("span", "agent-eyebrow", example ? "EXAMPLE · YOUR ANSWER" : "YOUR ANSWER"), element("h3", "", title));
  if (description) card.append(element("p", "agent-card-help", description));
  const form = element("form", "agent-answer-form");
  for (const field of fields) {
    if (field.options) {
      const group = element("fieldset", "agent-choices"); group.append(element("legend", "", field.label));
      for (const option of field.options) {
        const label = element("label", "agent-choice");
        const input = element("input"); input.type = "radio"; input.name = field.name; input.value = option.value; input.required = field.required !== false;
        input.checked = field.value === option.value;
        const text = element("span"); text.append(element("strong", "", option.label));
        if (option.description) text.append(element("small", "", option.description));
        label.append(input, text); group.append(label);
      }
      form.append(group);
    } else {
      const label = element("label"); label.append(element("span", "", field.label));
      const input = element(field.multiline ? "textarea" : "input"); input.name = field.name;
      input.required = field.required !== false; input.maxLength = field.multiline ? 2000 : 200;
      input.value = field.value || ""; input.placeholder = field.placeholder || "";
      label.append(input); form.append(label);
    }
  }
  const note = element("p", "agent-card-help", example ? "Example only. Sending an answer does not approve a change." : "An answer supplies details. You will still preview and approve any change separately.");
  const submit = element("button", "primary", submitLabel); submit.type = "submit";
  const error = element("p", "agent-error"); error.setAttribute("role", "alert");
  form.append(note, submit, error); card.append(form);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const controls = [...form.elements]; controls.forEach((node) => { node.disabled = true; }); error.textContent = "";
    try { await onAnswer(values); form.replaceChildren(element("p", "agent-receipt", example ? "Example answer received. No workspace changes were made." : "Answer sent.")); }
    catch (e) { error.textContent = e.message; controls.forEach((node) => { node.disabled = false; }); }
  });
  return card;
}

export const typewriterComposer = `
  <form id="agentComposer" class="agent-typewriter">
    <div class="agent-input-paper"><label class="sr-only" for="agentInput">Message the assistant</label><textarea id="agentInput" rows="1" maxlength="${CHAT_LIMITS.messageCharacters}" placeholder="Type your next idea…" required></textarea><button class="typewriter-return" type="submit" aria-label="Send message" title="Send message (Enter)">Send <span aria-hidden="true">↵</span></button></div>
  </form>`;

async function readWorkspacePages(organizationId) {
  const input = { organizationId, limit: 100 };
  const { result } = await request("/api/actions/workspace.get", input);
  for (const [collection, cursorName] of [["projects", "projectCursor"], ["businessUnits", "businessUnitCursor"]]) {
    let cursor = result.pages[collection].nextCursor;
    const seen = new Set();
    while (cursor) {
      if (seen.has(cursor)) throw new Error("The workspace could not load its next page. Please retry.");
      seen.add(cursor);
      const next = (await request("/api/actions/workspace.get", { ...input, [cursorName]: cursor })).result;
      result[collection].push(...next[collection]); cursor = next.pages[collection].nextCursor;
    }
  }
  return result;
}
function jobLine(job, edit) {
  const line = element("div", "workspace-job");
  line.dataset.resourceType = "job"; line.dataset.resourceId = job.id;
  line.append(element("strong", "", job.name), element("span", "", `${job.status === "draft" ? "Draft" : job.status} · ${job.sourceCount} source strings · ${job.targetLocales.join(", ")}`));
  if (job.canEdit) line.append(edit(job));
  return line;
}

export class Workspace {
  constructor(root, controllerId, onScope) { this.root = root; this.controllerId = controllerId; this.onScope = onScope; this.organizationId = null; }
  async refresh(organizationId = this.organizationId, focusJobId = null) {
    if (!this.root) return;
    const generation = this.refreshGeneration = (this.refreshGeneration || 0) + 1;
    this.organizationId = organizationId;
    const config = await request("/api/agent/config");
    const fragment = document.createDocumentFragment();
    const head = element("header", "workspace-heading");
    if (organizationId) { head.dataset.resourceType = "organization"; head.dataset.resourceId = organizationId; }
    head.append(element("span", "agent-eyebrow", "PROJECTS"), element("h1", "", "Your projects, in every language."), element("p", "", "Explore projects and jobs by business unit, or preview your next workspace change."));
    const select = element("select"); select.setAttribute("aria-label", "Workspace organization");
    select.append(new Option("New organization", ""));
    for (const org of config.organizations) select.append(new Option(org.name, org.id));
    select.value = organizationId || "";
    select.addEventListener("change", () => this.onScope(select.value || null)); head.append(select); fragment.append(head);
    let data = { businessUnits: [], projects: [] };
    if (organizationId) data = await readWorkspacePages(organizationId);
    const input = (name, label, value = "") => ({ name, label, value });
    const permissions = data.organization?.permissions || [];
    if (permissions.includes("organization.update")) head.append(this.form("organization.update", [input("name", "Organization name", data.organization.name)], { organizationId }, "Edit organization name"));
    const editJob = (job) => this.form("localization_job.update", [input("name", "Job name", job.name), input("targetLocales", "Target languages, separated by commas", job.targetLocales.join(", ")),
      { name: "steps", label: "Workflow steps", multi: true, value: job.steps, options: [...new Set([...job.steps, ...Object.keys(workflowLabels)])].map((step) => [step, workflowLabels[step]]) },
    ], { jobId: job.id }, `Edit job: ${job.name}`);
    let recentJobs = [];
    if (organizationId && data.projects.some((p) => p.canViewJobs)) {
      recentJobs = (await request("/api/actions/localization_jobs.list", { organizationId, limit: 100 })).result.jobs;
      if (focusJobId && !recentJobs.some((job) => job.id === focusJobId)) {
        const focused = (await request("/api/actions/localization_jobs.list", { organizationId, jobId: focusJobId })).result.jobs;
        recentJobs.push(...focused);
      }
    }
    const resources = element("div", "workspace-resources");
    for (const unit of data.businessUnits) {
      const card = element("article", "workspace-resource"); card.append(element("span", "agent-eyebrow", "BUSINESS UNIT"), element("h2", "", unit.name));
      card.dataset.resourceType = "business_unit"; card.dataset.resourceId = unit.id;
      if (permissions.includes("business_units.manage")) card.append(this.form("business_unit.update", [input("name", "Business-unit name", unit.name)], { businessUnitId: unit.id }, `Edit business unit: ${unit.name}`));
      const projects = data.projects.filter((p) => p.businessUnitId === unit.id);
      for (const p of projects) {
        const link = element("button", "workspace-project", p.name); link.type = "button";
        link.dataset.resourceType = "project"; link.dataset.resourceId = p.id;
        link.addEventListener("click", () => window.HedgelingConsole?.openProject(p.slug, { manual: true })); card.append(link);
        if (p.canEdit) card.append(this.form("project.update", [input("name", "Project name", p.name)], { projectSlug: p.slug }, `Edit project: ${p.name}`));
        card.append(projectLanguages({ project: p, request, confirmation: workspaceConfirmation, controllerId: this.controllerId,
          onSaved: () => window.HedgelingConsole?.refresh() }));
        if (p.canExtract) card.append(extractionPanel({ project: p, request, confirmation: workspaceConfirmation, controllerId: this.controllerId,
          onImported: () => window.HedgelingConsole?.refresh() }));
        if (p.canViewJobs) {
          const jobs = element("div");
          for (const job of recentJobs.filter((job) => job.projectSlug === p.slug)) jobs.append(jobLine(job, editJob));
          const more = element("button", "workspace-project", "Browse jobs"); more.type = "button";
          more.setAttribute("aria-label", `Browse jobs in ${p.name}`);
          const info = element("p", "agent-card-help"); info.setAttribute("role", "status");
          let cursor = null, loaded = 0;
          more.addEventListener("click", async () => {
            more.disabled = true;
            try {
              const { result } = await request("/api/actions/localization_jobs.list", { projectSlug: p.slug, limit: 50, ...(cursor ? { cursor } : {}) });
              if (generation !== this.refreshGeneration) return;
              if (!cursor) jobs.replaceChildren();
              for (const job of result.jobs) jobs.append(jobLine(job, editJob));
              loaded += result.jobs.length; cursor = result.page.nextCursor;
              info.textContent = `${loaded} of ${result.page.total} jobs shown`;
              more.textContent = "Load more jobs"; more.setAttribute("aria-label", `Load more jobs in ${p.name}`); more.hidden = !result.page.hasMore;
            } catch (error) { info.textContent = error.message; }
            finally { more.disabled = false; }
          });
          card.append(jobs, more, info);
        }
      }
      if (!projects.length) card.append(element("p", "", "No projects yet.")); resources.append(card);
    }
    if (organizationId && !data.businessUnits.length) resources.append(element("p", "workspace-empty", "Your organization is ready. Create a business unit to organize its projects."));
    fragment.append(resources);
    const forms = element("div", "workspace-forms");
    if (!organizationId && config.organizationCreation) forms.append(this.form("organization.create", [input("name", "Organization name")]));
    if (organizationId && permissions.includes("business_units.create")) forms.append(this.form("business_unit.create", [input("name", "Business-unit name")], { organizationId }));
    if (data.businessUnits.length && permissions.includes("projects.create")) forms.append(this.form("project.create", [
      { name: "businessUnitId", label: "Business unit", options: data.businessUnits.map((u) => [u.id, u.name]) }, input("name", "Project name"), input("sourceLocale", "Source language", "en"), input("targetLocales", "Target languages, separated by commas", "fr, de"),
    ]));
    const jobProjects = data.projects.filter((p) => p.canCreateJob);
    if (jobProjects.length) forms.append(this.form("localization_job.create", [
      { name: "projectSlug", label: "Project", options: jobProjects.map((p) => [p.slug, p.name]) }, input("name", "Job name"), input("targetLocales", "Target languages, separated by commas", jobProjects[0].targetLocales.join(", ")),
      { name: "workflow", label: "Workflow", options: [["machine_translation,review", "AI translation → Human review"], ["human_translation,review", "Human translation → Review"], ["machine_translation,review,qa", "AI translation → Review → QA"]] },
    ]));
    fragment.append(forms);
    if (generation === this.refreshGeneration) {
      // Keep open source forms/approvals intact during agent-driven refreshes.
      // Only retain a panel when the refreshed project still permits extraction.
      const panels = new Map([...this.root.querySelectorAll('.extraction-panel')].map(node => [node.dataset.projectId, node]));
      for (const next of fragment.querySelectorAll('.extraction-panel')) {
        const current = panels.get(next.dataset.projectId);
        if (current) next.replaceWith(current);
      }
      this.root.replaceChildren(fragment); window.HedgelingShell?.workspaceChanged(organizationId);
    }
  }
  form(action, fields, fixed = {}, title = null) {
    const details = element("details", `workspace-form${title ? " workspace-inline-edit" : ""}`); details.dataset.workspaceAction = action; details.append(element("summary", "", title || actionLabel[action]));
    const form = element("form");
    const inputs = element("fieldset", "workspace-form-fields");
    const preview = element("div");
    for (const field of fields) {
      if (field.multi) {
        const group = element("fieldset", "workspace-step-options"); group.append(element("legend", "", field.label));
        for (const [value, title] of field.options) {
          const label = element("label"); const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.name = field.name; checkbox.value = value; checkbox.defaultChecked = field.value.includes(value);
          label.append(checkbox, document.createTextNode(title)); group.append(label);
        }
        inputs.append(group); continue;
      }
      const label = element("label"); label.append(element("span", "", field.label));
      const control = element(field.options ? "select" : "input"); control.name = field.name; control.required = true;
      if (field.options) for (const [value, title] of field.options) control.append(new Option(title, value));
      else { control.defaultValue = field.value; control.maxLength = 200; }
      label.append(control); inputs.append(label);
    }
    const submit = element("button", "primary", "Preview change"); submit.type = "submit";
    const error = element("p", "agent-error"); error.setAttribute("role", "alert");
    form.append(inputs, submit, error);
    const returnToForm = async (proposal, cancel = false) => {
      await request(`/api/agent/proposals/${proposal.id}/reject`, {});
      preview.replaceChildren(); form.hidden = false;
      if (cancel) { form.reset(); details.open = false; details.querySelector("summary").focus(); }
      else form.querySelector("input,select,textarea")?.focus();
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled || form.hidden) return;
      submit.disabled = true; error.textContent = "";
      try {
        const values = { ...fixed, ...Object.fromEntries(new FormData(form)) };
        for (const field of fields.filter((f) => f.multi)) values[field.name] = new FormData(form).getAll(field.name);
        if (values.targetLocales) values.targetLocales = values.targetLocales.split(",").map((v) => v.trim()).filter(Boolean);
        if (values.workflow) { values.steps = values.workflow.split(","); delete values.workflow; }
        if (action.endsWith(".update")) {
          for (const field of fields) {
            const before = field.name === "targetLocales" ? field.value.split(",").map((v) => v.trim()).filter(Boolean) : field.value;
            if (JSON.stringify(values[field.name]) === JSON.stringify(before)) delete values[field.name];
          }
          if (!fields.some((field) => Object.hasOwn(values, field.name))) throw new Error("Change a field first, then preview your update.");
        }
        // Keep the reviewed values stable while the preview request is in flight.
        inputs.disabled = true;
        const { result } = await request(`/api/actions/${action}`, values);
        preview.replaceChildren(workspaceConfirmation(result.proposal, {
          confirm: async (proposal) => {
            const { result } = await request(`/api/agent/proposals/${proposal.id}/confirm`, { fingerprint: proposal.fingerprint, controllerId: this.controllerId });
            await this.onScope(result.uiTarget.organizationId, result.job?.id); await window.HedgelingConsole?.refresh();
            const resource = result.uiTarget.resource;
            const target = [...this.root.querySelectorAll("[data-resource-id]")].find((node) => node.dataset.resourceType === resource?.type && node.dataset.resourceId === resource.id);
            if (target) { if (!target.matches("button,a,input,select")) target.tabIndex = -1; target.focus(); }
          },
          edit: (proposal) => returnToForm(proposal),
          cancel: (proposal) => returnToForm(proposal, true),
        }));
        form.hidden = true;
        preview.querySelector("h3").focus();
      } catch (e) { error.textContent = e.message; }
      finally { submit.disabled = false; inputs.disabled = false; }
    });
    details.append(form, preview); return details;
  }
}
