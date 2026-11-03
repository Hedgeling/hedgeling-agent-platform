import { workspaceConfirmation } from './agent-components.js';
import { localizationFlowCard } from './localization-flow.js';
import { translationJobProgress, jobQualityPanel } from './translation-jobs.js';
import { contextProgress } from './context-enrichment.js';
import { openDocumentUpload, fileCard } from './documents.js';
import { isDocumentDownload } from './document-files.js';
import { agentNotifications } from './agent-notifications.js';
import { panelResizer } from './agent-resizer.js';
import { bindComposer } from './agent-composer.js';
import { activityGroup } from './agent-activity.js';
import { githubConnectionCard } from './github-connection.js';
import { renderChatMarkdown } from "./chat-markdown.js";
import { request, element, proposalCard, Workspace, typewriterComposer } from "./agent-components.js";
import { extractionProgress } from './extraction.js';

// A duplicated tab copies sessionStorage. Give every document its own lease
// identity so two tabs can never accidentally share control.
import { AgentAttention, actionForTool } from "./agent-attention.js";

const controllerId = crypto.randomUUID();
let config, brand, run, stream, heartbeat, workspace, userId;
let notifications, composer, turnHasReply = false;
let markInitialized;
const initialized = new Promise((resolve) => { markInitialized = resolve; });
const hasWorkspace = Boolean(document.getElementById("workspaceRoot"));
let mode = localStorage.getItem("hedgeling.agent.mode") || (hasWorkspace ? "overlay" : "minimized");
let scope = null, cursor = 0, dirty = false, switching = false;
const seen = new Set();
const confirmed = new Set();
const inertBeforeOverlay = new Map();
const attention = new AgentAttention();
let attentionGeneration = 0;
let activation = null;
let conversationChange = Promise.resolve();
const drafts = new Map();
const shell = element("section", "agent-shell"); shell.id = "hedgelingAgent"; shell.tabIndex = -1;
shell.innerHTML = `
  <div id="agentResizeHandle" class="agent-resize-handle" role="separator" tabindex="0" aria-label="Resize chat panel" aria-orientation="vertical" aria-controls="hedgelingAgent" title="Drag to resize. Use arrow keys when focused."></div>
  <header class="agent-header">
    <div class="agent-identity"><span class="agent-emblem agent-avatar" aria-hidden="true"><img alt=""></span><div><strong data-agent-name>Agent Hedgeling</strong><span id="agentStatus" role="status" aria-live="polite">Ready when you are</span></div></div>
    <div class="agent-window-controls" role="group" aria-label="Chat layout">
      <button type="button" class="agent-tool-button" data-mode="overlay" aria-label="Full-screen chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg><span class="agent-tool-label" aria-hidden="true">Full-screen chat</span></button>
      <button type="button" class="agent-tool-button" data-mode="panel" aria-label="Side panel"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></svg><span class="agent-tool-label" aria-hidden="true">Side panel</span></button>
      <button type="button" class="agent-tool-button" data-mode="minimized" aria-label="Minimize chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18h14"/></svg><span class="agent-tool-label" aria-hidden="true">Minimize chat</span></button>
    </div>
  </header>
  <div class="agent-context"><label><span>Working in</span><select id="agentScope" aria-label="Conversation organization" disabled></select></label><button type="button" id="agentNew" class="agent-tool-button" aria-label="New chat" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="agent-tool-label" aria-hidden="true">New chat</span></button></div>
  <div id="agentPlanNotice" class="agent-plan-notice" hidden><p id="agentPlanMessage"></p><button type="button" id="agentUpgrade">View plans</button></div>
  <div class="agent-scroll"><div class="agent-paper"><div id="agentWelcome" class="agent-welcome"><span class="agent-emblem agent-hero" aria-hidden="true"><img alt=""></span><span class="agent-eyebrow">YOUR LOCALIZATION COPILOT</span><h1>What shall we work on?</h1><p>Build a workspace. Find the right words.<br>Keep every language moving.</p><div id="agentSuggestions" class="agent-suggestions"></div></div><div id="agentMessages" role="log" aria-label="Conversation"></div></div></div>
  <div id="agentError" class="agent-error" role="alert"></div>
  <footer class="agent-footer">
  <p id="agentComposerHint" class="agent-composer-hint" role="status" aria-live="polite" hidden></p>
  ${typewriterComposer}
  <div class="agent-run-controls" role="group" aria-label="Conversation actions">
    <button type="button" id="agentUploadDocument" class="agent-tool-button" aria-label="Upload document" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"/></svg><span class="agent-tool-label" aria-hidden="true">Upload document</span></button>
    <button type="button" id="agentTakeControl" hidden>Take control</button>
    <button type="button" id="agentPause" class="agent-tool-button" aria-label="Pause"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg><span class="agent-tool-label" aria-hidden="true">Pause</span></button>
    <button type="button" id="agentTakeover" class="agent-tool-button" aria-label="Take over"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v10c0 4-3 6-6 6h-2c-2 0-3-1-4-3l-4-6a2 2 0 0 1 3-2l1 1Z"/></svg><span class="agent-tool-label" aria-hidden="true">Take over</span></button>
    <button type="button" id="agentCancel" class="agent-tool-button agent-tool-cancel" aria-label="Cancel task"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span class="agent-tool-label" aria-hidden="true">Cancel task</span></button>
    <button type="button" id="agentSound" class="agent-tool-button" aria-label="Sound off" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path class="sound-on" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sound-off" d="m16 9 6 6m0-6-6 6"/></svg><span class="agent-tool-label" aria-hidden="true">Sound off</span></button>
    <button type="button" id="agentOpaque" class="agent-tool-button" aria-label="Hide workspace edges" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h10v10H7Z"/></svg><span class="agent-tool-label" aria-hidden="true">Hide workspace edges</span></button>
    <label><input type="checkbox" id="agentFollow" checked> Follow along</label>
  </div>
  <div class="agent-footnote"><span id="agentProviderLabel">You confirm every change.</span><a id="agentCardExamples" href="/agent-preview.html" target="_blank" rel="noopener" hidden>Try card examples ↗</a></div></footer>`;
const launcher = element("button", "agent-launcher"); launcher.type = "button"; launcher.setAttribute("aria-label", "Open Hedgeling assistant");
launcher.innerHTML = '<span class="agent-emblem agent-launcher-emblem" aria-hidden="true"><img alt=""></span><span class="agent-launcher-label">Ask Hedgeling</span><i aria-hidden="true"></i>';
const $ = (id) => shell.querySelector(`#${id}`);
const activity = activityGroup($('agentMessages'));
const nearLatest = () => { const scroller = shell.querySelector('.agent-scroll'); return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90; };
function scopeChat() {
  const organization = config?.organizations.find((org) => org.id === scope);
  if (organization?.agentAccess?.allowed === false) return { ...organization.agentAccess, reason: "organization_access_required" };
  return (scope ? organization?.chat : config?.unscopedChat) || { allowed: false, message: "Choose an organization to start chatting." };
}
function showError(error) {
  attentionGeneration++; attention.clear(); $("agentError").textContent = error?.message || String(error);
  if (error?.code === "agent_plan_required") { const chat = scopeChat(); chat.allowed = false; chat.message = error.message; updateState(run?.status || "awaiting_input"); }
  if (error?.code === "agent_organization_access_required") {
    const organization = config?.organizations.find((org) => org.id === scope);
    if (organization) organization.agentAccess = { allowed: false, message: error.message };
    updateState(run?.status || "awaiting_input");
  }
}
function setMode(next, focus = true) {
  if (next === "panel" && matchMedia("(max-width: 760px)").matches) next = "overlay";
  mode = next; shell.dataset.mode = next; document.body.dataset.agentMode = next;
  localStorage.setItem("hedgeling.agent.mode", next);
  shell.hidden = next === "minimized"; launcher.hidden = next !== "minimized";
  shell.setAttribute("role", next === "overlay" ? "dialog" : "complementary");
  shell.setAttribute("aria-label", brand?.agentTitle || `${brand?.agentName || "Hedgeling"} assistant`);
  if (next === "overlay") shell.setAttribute("aria-modal", "true"); else shell.removeAttribute("aria-modal");
  if (next === "overlay") {
    for (const node of document.body.children) {
      if ([shell, launcher, notifications?.region].includes(node) || ["SCRIPT", "LINK", "STYLE"].includes(node.tagName)) continue;
      if (!inertBeforeOverlay.has(node)) inertBeforeOverlay.set(node, node.inert);
      node.inert = true;
    }
  } else {
    for (const [node, wasInert] of inertBeforeOverlay) node.inert = wasInert;
    inertBeforeOverlay.clear();
  }
  for (const button of shell.querySelectorAll(".agent-window-controls button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === next));
    button.disabled = button.dataset.mode === "panel" && matchMedia("(max-width: 760px)").matches;
  }
  $("agentOpaque").hidden = next !== "overlay";
  // Opening or resizing a paused conversation must not resume it by itself.
  if (focus) (next === "minimized" ? launcher : !$("agentTakeControl").hidden ? $("agentTakeControl") : run?.status === "paused" ? shell : $("agentInput")).focus();
  if (next !== "minimized" && run?.status === "awaiting_confirmation") requestAnimationFrame(() => {
    const scroller = shell.querySelector(".agent-scroll"); scroller.scrollTop = scroller.scrollHeight;
  });
  notifications?.read();
  composer?.resize();
}
function updateState(status) {
  if (run) run.status = status;
  if (["paused", "cancelled", "failed"].includes(status)) { attentionGeneration++; attention.clear(); }
  const labels = { awaiting_input: "Ready when you are", planning: "Planning the next step", reading: "Looking at your workspace", awaiting_confirmation: "Waiting for your confirmation", paused: "Paused · You’re in control", cancelled: "Task cancelled", completed: "All done", executing: "Applying your confirmed change" };
  $("agentStatus").textContent = labels[status] || status;
  launcher.dataset.status = status;
  for (const surface of [shell, launcher]) surface.dataset.working = String(["planning", "reading", "executing"].includes(status));
  launcher.setAttribute("aria-label", `Open ${brand?.agentName || "Hedgeling"} assistant. ${labels[status] || status}`);
  const paused = status === "paused";
  const otherController = run?.controllerId && run.controllerId !== controllerId && status !== "cancelled";
  if (otherController) $("agentStatus").textContent = "Viewing conversation · Take control to continue";
  $("agentTakeControl").hidden = !otherController; $("agentPause").hidden = paused;
  const chat = scopeChat();
  $('agentUploadDocument').disabled = !scope || switching || Boolean(otherController);
  const organization = config?.organizations.find((org) => org.id === scope);
  const roleRequired = chat.reason === "organization_access_required";
  const canBill = !roleRequired && organization?.permissions?.includes("billing.manage");
  $("agentPlanNotice").hidden = chat.allowed;
  $("agentPlanMessage").textContent = `${chat.message || ""}${scope && !canBill && !roleRequired ? " Ask your organization owner or billing administrator to review the plan." : ""}`;
  $("agentUpgrade").hidden = !scope || !canBill;
  $("agentTakeControl").disabled = !chat.allowed || Boolean(activation);
  $("agentInput").disabled = switching || !chat.allowed || !config?.ready || otherController || !["awaiting_input", "completed", "paused"].includes(status);
  const hint = roleRequired ? "Choose another workspace, or have your organization role reviewed before starting a new chat."
    : !chat.allowed ? "Your conversation is saved. Choose an active workspace or review your plan to continue."
    : !config?.ready ? "The assistant is unavailable. You can continue manually."
    : otherController ? "Select Take control to continue this conversation here."
    : paused ? activation ? "Reconnecting your conversation… Your draft will stay here." : "Click or tab into the message field to continue. Nothing is sent until you press Send."
    : status === "awaiting_confirmation" ? "Review the pending change above to continue."
    : ["cancelled", "failed"].includes(status) ? "Start a new chat to type again."
    : $("agentInput").disabled ? "Hedgeling is working. You can type again when this step finishes." : "";
  $("agentComposerHint").textContent = hint;
  $("agentComposerHint").hidden = !hint;
  $("agentInput").setAttribute("aria-describedby", "agentComposerHint agentInputHelp");
  $("agentInput").placeholder = otherController ? "Select Take control below…" : paused ? "Click here to continue chatting…" : "Type your next idea…";
  $("agentComposer").querySelector("button").disabled = $("agentInput").disabled || paused || Boolean(activation);
  $("agentPause").disabled = !run; $("agentCancel").disabled = !run || status === "cancelled";
  for (const button of shell.querySelectorAll(".agent-proposal button")) button.disabled = switching || !chat.allowed || otherController || status !== "awaiting_confirmation";
}
function message(role, text, { replay = false, createdAt } = {}) {
  $("agentWelcome").hidden = true;
  const item = element("article", `agent-message agent-message-${role}`);
  const content = element("div", "agent-message-content");
  if (role === "user") { const paragraph = element("p", "", text); content.append(paragraph); }
  else content.append(renderChatMarkdown(text));
  // Reveal formatted content as a whole: never flash raw Markdown markers.
  if (role !== "user" && !replay) content.classList.add("agent-ink-reveal");
  const header = element('header', 'agent-message-header');
  header.append(element("span", "agent-message-author", role === "user" ? "You" : brand.agentName));
  if (createdAt && Number.isFinite(Date.parse(createdAt))) {
    const time = element('time', '', new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); time.dateTime = new Date(createdAt).toISOString(); header.append(time);
  }
  item.append(header, content);
  $("agentMessages").append(item);
}
function hasUnsavedEdits() {
  return dirty || window.HedgelingConsole?.libraryDirty() || document.querySelector('[data-document-dirty="true"]') || [...document.querySelectorAll('.project-languages form input')].some(input => input.value.trim());
}
async function follow(target, { phase = "working", card, label = "Looking at this section" } = {}) {
  const generation = ++attentionGeneration;
  if (!target || !$("agentFollow").checked || ["paused", "cancelled"].includes(run?.status)) return;
  if (hasUnsavedEdits()) { await pauseRun(); showError(new Error("Your unsaved edits are still on screen. Save them before resuming the agent.")); return; }
  if (target.view === 'library') {
    await window.HedgelingConsole?.openLibrary(target.projectSlug, target.kind);
    if (generation !== attentionGeneration || !$("agentFollow").checked) return;
    attention.show({ action: target.action || 'library.read', resource: target.resource, phase, card, label });
  }
  if (target.view === "workspace") {
    await workspace.refresh(target.organizationId, target.resource?.type === "job" ? target.resource.id : null, target.resource);
    if (generation !== attentionGeneration || !$("agentFollow").checked || ["paused", "cancelled"].includes(run?.status)) return;
    window.HedgelingConsole?.openWorkspace();
    attention.show({ action: target.action || "read", resource: target.resource, phase, card, label });
  }
}
function receive(item, { replay = false } = {}) {
  if (seen.has(String(item.sequence))) return;
  seen.add(String(item.sequence)); cursor = Math.max(cursor, Number(item.sequence));
  const { kind, data } = item;
  const stickToLatest = nearLatest() || kind === 'message' && data.role === 'user';
  let notice;
  if (kind === 'github_connection' && !$('agentMessages').querySelector('.github-connection-card')) {
    const card = githubConnectionCard({ request }); $('agentMessages').append(card.root); void card.refresh();
  }
  if (kind === 'files') for (const file of (Array.isArray(data.files) ? data.files : []).filter(isDocumentDownload)) $('agentMessages').append(fileCard(file));
  if (kind === "commercial_access") { const chat = scopeChat(); chat.allowed = false; chat.message = data.message; updateState(run?.status || "paused"); }
  if (kind === "message") {
    if (data.role === 'user') { activity.reset(); turnHasReply = false; }
    else if (!replay) turnHasReply = true;
    message(data.role, data.text, { replay, createdAt: item.createdAt });
  }
  if (kind === "activity") {
    activity.add(data);
    if (!replay && data.status === "working" && actionForTool(data.tool)) void follow({ view: actionForTool(data.tool).startsWith("library.") ? "library" : "workspace", organizationId: scope, action: actionForTool(data.tool) }, { label: data.label }).catch(showError);
    if (!replay && data.status === 'complete' && data.uiTarget?.view === 'library') void follow(data.uiTarget, { label: data.label }).catch(showError);
    if (!replay && data.status === "failed") { attentionGeneration++; attention.clear(); }
  }
  if (kind === "state") {
    const previous = run?.status;
    if (['awaiting_input', 'awaiting_confirmation', 'paused', 'completed', 'cancelled'].includes(data.status)) activity.finish(data.status);
    if (!replay && data.status !== previous) {
      if (data.status === 'awaiting_confirmation') notice = 'Hedgeling needs your approval.';
      else if (['awaiting_input', 'completed', 'paused'].includes(data.status) && turnHasReply) notice = data.status === 'paused' ? 'Hedgeling needs your attention.' : 'Hedgeling replied. Your next step is ready.';
    }
    if (['awaiting_input', 'awaiting_confirmation', 'paused', 'completed', 'planning'].includes(data.status)) turnHasReply = false;
    if (run && Object.hasOwn(data, "controllerId")) run.controllerId = data.controllerId;
    if (data.organizationId) { scope = data.organizationId; if (run) run.organizationId = scope; if (!replay) rememberConversation(); void refreshScopes(); }
    updateState(data.status);
  }
  if (kind === "proposal" && !confirmed.has(data.id) && !shell.querySelector(`[data-proposal-id="${data.id}"]`)) {
    $("agentWelcome").hidden = true;
    $("agentMessages").append(proposalCard(data, async (proposal) => {
      if ($("agentFollow").checked) attention.show({ action: proposal.preview.action, phase: "working", label: "Applying your confirmed change", card: shell.querySelector(`[data-proposal-id="${proposal.id}"]`) });
      const result = await request(`/api/agent/proposals/${proposal.id}/confirm`, { fingerprint: proposal.fingerprint, controllerId });
      confirmed.add(proposal.id); scope = result.result.uiTarget.organizationId;
      await refreshScopes(); await workspace.refresh(scope, result.result.job?.id); await window.HedgelingConsole?.refresh();
      await follow(result.result.uiTarget, { phase: "complete", label: proposal.preview.action.endsWith(".update") ? "Updated · ready to inspect" : "Created · ready to inspect" });
      if (run?.status !== "paused") await request(`/api/agent/runs/${run.id}/continue`, { controllerId });
    }, async (proposal) => { await request(`/api/agent/proposals/${proposal.id}/reject`, { controllerId }); }, { edit: async proposal => {
      await request(`/api/agent/proposals/${proposal.id}/reject`, { controllerId });
      $("agentFollow").checked=false;attention.clear();setMode('minimized');
      await window.HedgelingConsole?.openLibrary(proposal.preview.fields.projectSlug, proposal.preview.library.kind, proposal.preview.fields);
    } }));
    if (!replay) void follow(data.uiTarget || { view: "workspace", organizationId: scope, action: data.preview.action }, { phase: "approval", card: shell.querySelector(`[data-proposal-id="${data.id}"]`), label: "Your approval is needed here" }).catch(showError);
  }
  if ((kind === 'flow' || kind === 'result') && data.uiTarget?.projectSlug) {
    const projectSlug = data.uiTarget.projectSlug;
    const existing = [...$('agentMessages').querySelectorAll('[data-flow-project]')].find(card => card.dataset.flowProject === projectSlug);
    if (existing) { existing.dispatchEvent(new Event('localization-flow-refresh')); $('agentMessages').append(existing); }
    else $('agentMessages').append(localizationFlowCard({ projectSlug, request, confirmation: workspaceConfirmation, controllerId,
      onChanged: () => workspace.refresh(scope), onNavigate: async ({ section, step, jobId }) => {
        setMode('minimized'); window.HedgelingConsole?.navigate('workspace', { manual: true, load: false });
        await workspace.refresh(data.uiTarget.organizationId, jobId, { type: 'project', id: projectSlug });
        const card = [...document.querySelectorAll('#workspaceRoot [data-flow-project]')].find(n => n.dataset.flowProject === projectSlug);
        const project = card?.parentElement;
        const area = jobId && section === '05' ? [...(project?.querySelectorAll('[data-resource-type="job"]') || [])].find(n => n.dataset.resourceId === jobId) : project?.querySelector(`[data-workflow-step="${section}"]`);
        const panel = area?.querySelector(step === 'deliver' ? '.job-delivery' : section === '03' ? '.context-panel' : '.job-quality');
        if (panel?.tagName === 'DETAILS') panel.open = true;
        area?.scrollIntoView({ block: 'start' });
      } }));
  }
  if (kind === "result") {
    confirmed.add(data.proposalId);
    const card = shell.querySelector(`[data-proposal-id="${data.proposalId}"]`);
    if (card) card.replaceChildren(element("p", "agent-receipt", "✓ Change confirmed"));
    if (data.uiTarget?.action === 'repositories.connect') {
      message('assistant', `${data.repository} is connected. We can now preview a scan of your selected paths.`, { replay });
      if (!replay) for (const panel of document.querySelectorAll('[data-project-id]')) {
        if (panel.dataset.projectId === data.uiTarget.resource?.id) panel.dispatchEvent(new Event('repository-refresh'));
      }
    }
    const resource = data.organization || data.businessUnit || data.project || data.job;
    if (data.qualityRun) {
      message('assistant', data.qualityRun.status === 'applied' ? `${data.qualityRun.verified} passing translations verified after your confirmation.` : data.qualityRun.status === 'cancelled' ? 'Remaining quality checks stopped.' : 'AI quality check queued. Findings appear below; verification requires a separate confirmation.', { replay });
      $('agentMessages').append(jobQualityPanel({ jobId:data.qualityRun.jobId,runId:data.qualityRun.id,request,open:true,onPreview:async(action,input)=>{
        if(run?.status!=='awaiting_input') throw new Error('Finish the current chat turn first, or use the job controls in Projects.');
        await request(`/api/agent/runs/${run.id}/messages`,{controllerId,text:`Please prepare ${action} with ${JSON.stringify(input)}. Show the findings and wait for my confirmation.`});
      } }));
    }
    if(data.pullRequest) { const receipt=element('p','agent-receipt','Translation PR ready: '), link=element('a','',`PR #${data.pullRequest.number}`);link.href=data.pullRequest.url;link.target='_blank';link.rel='noopener noreferrer';receipt.append(link,document.createTextNode(' · Merge and deployment remain separate.'));$('agentMessages').append(receipt); }
    if (data.contextRun) $('agentMessages').append(contextProgress({ runId: data.contextRun.id, request, onReview: async contextRun => {
      if (run?.status !== 'awaiting_input') throw new Error('Finish the current chat turn first, or review the analysis in Projects.');
      await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: `Review context enrichment ${contextRun.id}. Summarize the suggestions and prepare accepting them; wait for my approval.` });
    }, onStop: async contextRun => {
      if (run?.status !== 'awaiting_input') throw new Error('Finish the current chat turn first, or stop the analysis in Projects.');
      await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: `Prepare stopping the remaining context enrichment batches for run ${contextRun.id}; wait for my confirmation.` });
    } }));
    if (data.uiTarget?.action === 'context.enrich' && data.accepted) message('assistant', `${data.accepted} context suggestions accepted for future translations. Existing translations and enforced limits are unchanged.`, { replay });
    if (data.library) message('assistant', data.library.status === 'submitted' ? `${data.library.label} was submitted for review. Active guidance is unchanged.` : data.library.status === 'rejected' ? `${data.library.label}: suggestion rejected.` : `${data.library.label} saved${data.library.active ? ' and active for future revisions' : ' as inactive guidance'}.`, { replay });
    if (data.job && data.job.status !== 'draft') {
      message('assistant', data.job.status === 'canceled' ? `${data.job.name} is stopping. Saved drafts remain for review.` : ['queued','running'].includes(data.job.status) ? `${data.job.name} is queued for translation. I’ll show its workflow and coverage below.` : `${data.job.name} uses saved translations. Its selected review and delivery steps appear below.`, { replay });
      $('agentMessages').append(translationJobProgress({ jobId: data.job.id, request,
        onStop: async jobId => {
          if (run?.status !== 'awaiting_input') throw new Error('Finish the current chat turn before requesting a job stop, or use Stop job in Projects.');
          await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: `Preview stopping translation job ${jobId}.` });
        } }));
    }
    else if (resource) message("assistant", data.addedLocales ? `Added ${data.addedLocales.join(", ")} to ${resource.name}.` : data.uiTarget?.action?.endsWith(".update") ? `${resource.name} has been updated.` : `${resource.name} is ready${data.job ? " as a draft" : ""}.`, { replay });
    if (data.extraction) $("agentMessages").append(extractionProgress({ projectSlug: data.extraction.projectSlug, extractionId: data.extraction.id, request,
      onTuneApply: async ({ projectSlug, extractionId }) => {
        if (run?.status !== 'awaiting_input') throw new Error('Click the chat field and finish any pending approval first.');
        await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: `Review applying tuning ${extractionId} to project ${projectSlug}. Prepare saving its accepted settings and re-extracting the pinned source; do not import yet.` });
      },
      onImport: async ({ projectSlug, extractionId }) => {
        if (run?.status !== 'awaiting_input') throw new Error('Resume the conversation and finish any pending approval before reviewing this import.');
        await request(`/api/agent/runs/${run.id}/messages`, { controllerId, text: `Review importing extraction ${extractionId} into project ${projectSlug}. Prepare the import preview; do not start another extraction.` });
      } }));
    if (data.import) {
      message('assistant', 'Your extracted source strings have been imported. Existing translations were preserved.', { replay });
      for (const progress of shell.querySelectorAll('[data-extraction-id]')) {
        if (progress.dataset.extractionId === data.import.extractionId) progress.dispatchEvent(new Event('extraction-refresh'));
      }
    }
    if (!hasWorkspace) {
      const link = element("a", "agent-workspace-link", "Open workspace to inspect this change"); link.href = "/?workspace=1";
      $("agentMessages").append(link);
    }
    if (!replay) void follow(data.uiTarget, { phase: "complete", label: "Created · ready to inspect" }).catch(showError);
  }
  if (kind === "proposal_rejected") {
    attentionGeneration++; attention.clear();
    const card = shell.querySelector(`[data-proposal-id="${data.proposalId}"]`); if (card) card.replaceChildren(element("p", "", "Proposal discarded."));
  }
  const scroller = shell.querySelector(".agent-scroll"); if (stickToLatest || replay) scroller.scrollTop = scroller.scrollHeight;
  if (notice) notifications?.show(notice);
}
function connect() {
  if (!run) return;
  stream?.close(); clearInterval(heartbeat);
  const connectedRun = run.id;
  const source = stream = new EventSource(`/api/agent/runs/${connectedRun}/events?after=${cursor}&controllerId=${controllerId}`);
  const current = () => stream === source && run?.id === connectedRun;
  source.onmessage = (event) => { if (!current()) return; try { receive(JSON.parse(event.data)); } catch { showError(new Error("Could not read an activity update. Reload the conversation.")); } };
  source.addEventListener("access_changed", () => { if (!current()) return; source.close(); clearInterval(heartbeat); showError(new Error("Your access changed. Start a new conversation.")); updateState("paused"); });
  source.onerror = () => { if (current()) $("agentStatus").textContent = "Connection interrupted · Reconnecting"; };
  heartbeat = setInterval(() => { if (current() && run.controllerId === controllerId && run.status !== "paused") void request(`/api/agent/runs/${connectedRun}/heartbeat`, { controllerId }).catch((error) => { if (current()) { updateState("paused"); showError(error); } }); }, 8000);
}
async function refreshScopes() {
  config = await request("/api/agent/config");
  window.HedgelingShell?.agentAvailable(config, brand);
  const select = $("agentScope"); select.replaceChildren(new Option("New organization", ""));
  if (CSS.supports('appearance', 'base-select')) {
    // Let long selected names shrink without pushing the picker arrow out of view.
    const button = element('button'); button.type = 'button';
    button.append(element('selectedcontent')); select.prepend(button);
  }
  for (const org of config.organizations) select.append(new Option(org.name, org.id));
  select.value = scope || "";
  updateState(run?.status || "awaiting_input");
}
const scopeKey = () => `hedgeling.agent.scope.${userId}`;
const runKey = (id) => `hedgeling.agent.workspace-run.${userId}.${id || "new"}`;
function rememberConversation() {
  sessionStorage.setItem(scopeKey(), scope || "");
  const legacyKey = `hedgeling.agent.run.${userId}`;
  if (run) {
    sessionStorage.setItem(legacyKey, run.id);
    sessionStorage.setItem(runKey(scope), run.id);
    // Creating an organization binds its formerly unscoped conversation.
    if (scope && sessionStorage.getItem(runKey(null)) === run.id) sessionStorage.removeItem(runKey(null));
  } else sessionStorage.removeItem(legacyKey);
}
async function restoreConversation(id, expectedScope) {
  let restored = await request(`/api/agent/runs/${id}`);
  if (expectedScope !== undefined && restored.run.organizationId !== expectedScope) return false;
  const events = [...restored.events];
  while (restored.eventsPage?.hasMore) {
    restored = await request(`/api/agent/runs/${id}?after=${restored.eventsPage.nextAfter}`);
    events.push(...restored.events);
  }
  if (expectedScope !== undefined && restored.run.organizationId !== expectedScope) return false;
  run = { ...restored.run }; scope = run.organizationId;
  for (const item of events) if (item.kind === "result") confirmed.add(item.data.proposalId);
  for (const item of events) receive(item, { replay: true });
  run = restored.run;
  return true;
}
function startConversation(organizationId = scope, options = {}) {
  // Serialize clicks so a slower request cannot replace a later workspace choice.
  const next = conversationChange.then(() => changeConversation(organizationId, options));
  conversationChange = next.catch(() => {});
  return next;
}
async function changeConversation(organizationId, { restore = false, refreshWorkspace = true } = {}) {
  if (restore && organizationId === scope && run) { await refreshScopes(); return; }
  switching = true;
  updateState(run?.status || "awaiting_input");
  $("agentScope").disabled = $("agentNew").disabled = true;
  try {
    if (activation) await activation;
    if (run?.controllerId === controllerId && !["paused", "cancelled"].includes(run.status)) {
      try { await pauseRun(); } catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    drafts.set(scope, $("agentInput").value);
    stream?.close(); stream = null; clearInterval(heartbeat); scope = organizationId;
    run = null;
    attentionGeneration++; attention.clear();
    cursor = 0; seen.clear(); confirmed.clear(); activity.reset(); notifications?.clear(); turnHasReply = false; $("agentMessages").replaceChildren(); $("agentWelcome").hidden = false; $("agentError").textContent = "";
    composer.setValue(restore ? drafts.get(scope) || '' : '');
    const saved = restore && sessionStorage.getItem(runKey(scope));
    if (saved) {
      try { await restoreConversation(saved, scope); }
      catch (error) { if (![403, 404].includes(error.status)) throw error; }
      if (!run) sessionStorage.removeItem(runKey(scope));
    }
    await refreshScopes();
    if (!run && config.ready && scopeChat().allowed) run = (await request("/api/agent/runs", { organizationId: scope, controllerId })).run;
    rememberConversation();
    if (refreshWorkspace) await workspace.refresh(scope);
    updateState(run?.status || "awaiting_input"); connect();
  } finally { switching = false; $("agentScope").disabled = $("agentNew").disabled = false; updateState(run?.status || "awaiting_input"); }
}
async function openConversation() {
  try {
    await initialized;
    const organizationId = window.HedgelingShell?.organizationContext();
    if (organizationId !== undefined) await startConversation(organizationId, { restore: true, refreshWorkspace: false });
    else { await conversationChange; await refreshScopes(); }
    setMode("panel");
  } catch (error) { showError(error); setMode("panel", false); }
}
async function pauseRun() {
  if (!run) return;
  const result = await request(`/api/agent/runs/${run.id}/pause`, { controllerId }); run = result.run; updateState(run.status);
}
async function activateComposer({ takeControl = false } = {}) {
  if (activation) return activation;
  if (!run || !scopeChat().allowed || switching || !config?.ready) return;
  const otherController = run.controllerId && run.controllerId !== controllerId;
  if (otherController && !takeControl) return;
  if (!otherController && run.status !== "paused") return;
  const currentRun = run.id;
  activation = (async () => {
    if (otherController) await pauseRun();
    const result = await request(`/api/agent/runs/${currentRun}/resume`, { controllerId });
    if (run?.id !== currentRun || run.generation > result.run.generation) return;
    run = result.run;
    // Preserve manual edits instead of refreshing the underlying workspace.
    if (hasUnsavedEdits()) $("agentFollow").checked = false;
    $("agentError").textContent = "";
    updateState(run.status);
    if (run.status === "awaiting_confirmation") shell.querySelector(".agent-proposal button:not(:disabled)")?.focus();
    else $("agentInput").focus();
  })();
  updateState(run.status);
  try { await activation; }
  finally { activation = null; updateState(run?.status || "awaiting_input"); }
}
async function initialize() {
  [config, brand] = await Promise.all([request("/api/agent/config"), request("/design-system/brand.json")]);
  userId = (await request("/api/me")).auth.user.id;
  document.body.append(shell, launcher);
  // Honor the saved layout before restoring history. Otherwise both the chat
  // and its launcher appear while loading, allowing a stale open to race a
  // user's minimize/navigation and cover their workspace on smaller screens.
  setMode(["overlay", "panel", "minimized"].includes(mode) ? mode : "overlay", false);
  panelResizer($('agentResizeHandle'));
  composer = bindComposer($('agentComposer'));
  for (const button of shell.querySelectorAll('.agent-tool-button')) {
    for (const event of ['pointerleave', 'blur']) button.addEventListener(event, () => delete button.dataset.tooltipDismissed);
  }
  shell.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const visible = shell.querySelectorAll('.agent-tool-button:is(:hover, :focus-visible):not([data-tooltip-dismissed])');
    if (!visible.length) return;
    event.preventDefault(); event.stopPropagation();
    for (const button of visible) button.dataset.tooltipDismissed = 'true';
  }, true);
  notifications = agentNotifications({ launcher, soundButton: $('agentSound'),
    isReading: () => !document.hidden && document.hasFocus() && mode !== 'minimized' && nearLatest(),
    open: () => { setMode(matchMedia('(max-width: 760px)').matches ? 'overlay' : 'panel'); const scroller = shell.querySelector('.agent-scroll'); scroller.scrollTop = scroller.scrollHeight; },
  });
  shell.querySelector('.agent-scroll').addEventListener('scroll', () => notifications.read(), { passive: true });
  document.addEventListener('visibilitychange', () => notifications.read());
  window.addEventListener('focus', () => notifications.read());
  shell.append(attention.status);
  window.HedgelingTheme?.syncControls();
  $("agentCardExamples").hidden = !config.demo;
  for (const image of [...shell.querySelectorAll(".agent-emblem img"), launcher.querySelector(".agent-emblem img")]) image.src = brand.mascot;
  for (const node of shell.querySelectorAll("[data-agent-name]")) node.textContent = brand.agentTitle || brand.agentName;
  launcher.querySelector(".agent-launcher-label").textContent = `Ask ${brand.agentName}`;
  for (const logo of document.querySelectorAll(".brand-logo")) logo.src = brand.logo;
  $("agentProviderLabel").textContent = config.demo ? "Local demo · Real changes still need confirmation" : "You confirm every change.";
  if (!config.ready) showError(new Error("The assistant is currently unavailable. You can use the workspace manually."));
  workspace = new Workspace(document.getElementById("workspaceRoot"), controllerId, async (id, jobId) => { await refreshScopes(); await workspace.refresh(id, jobId); });
  window.HedgelingAgent = {
    open: openConversation,
    async browseWorkspace(id) { await initialized; await workspace.refresh(id); },
    async showProjects() { await initialized; await workspace.refresh(workspace.organizationId || config.organizations[0]?.id || null); },
  };
  document.addEventListener("hedgeling:project-languages", async ({ detail }) => {
    try {
      setMode("minimized");
      window.HedgelingConsole?.navigate("workspace", { manual: true, load: false });
      await workspace.refresh(detail.organizationId, null, { type: 'project', id: detail.projectSlug });
      const panel = [...document.querySelectorAll('.project-languages')].find(node => node.dataset.projectSlug === detail.projectSlug);
      const details = panel?.querySelector('details');
      if (details) { details.open = true; details.querySelector('input')?.focus(); panel.scrollIntoView({ block: 'center' }); }
    } catch (error) { window.HedgelingConsole?.notify(error.message); }
  });
  window.HedgelingShell?.agentAvailable(config, brand);
  document.addEventListener("hedgeling:manual-navigation", () => { $("agentFollow").checked = false; attentionGeneration++; attention.clear(); });
  $("agentFollow").addEventListener("change", () => { if (!$("agentFollow").checked) { attentionGeneration++; attention.clear(); } });
  for (const button of shell.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
  launcher.addEventListener("click", openConversation);
  $("agentNew").addEventListener("click", () => startConversation().catch(showError));
  $('agentUploadDocument').addEventListener('click', () => {
    const organizationId = scope;
    if (!organizationId) return;
    void openDocumentUpload({ root: shell, organizationId, request, onChoose: ({ document, projectSlug }) => {
      if (scope !== organizationId) return showError(new Error('The workspace changed. Select the document again.'));
      composer.setValue(`Please inspect uploaded document ${document.id} in project ${projectSlug} and help me create a document translation job. Ask me for any missing language choices.`);
      $('agentInput').focus();
    } }).catch(showError);
  });
  $("agentScope").addEventListener("change", () => startConversation($("agentScope").value || null, { restore: true }).catch(showError));
  $("agentUpgrade").addEventListener("click", async () => {
    setMode("minimized");
    try { await window.HedgelingConsole?.openOrganization(scope); window.HedgelingConsole?.navigate("access", { manual: true, adminSection: "billing" }); }
    catch (error) { showError(error); }
  });
  window.addEventListener("focus", () => { void refreshScopes().catch(() => {}); });
  $("agentPause").addEventListener("click", () => pauseRun().catch(showError));
  $("agentTakeover").addEventListener("click", async () => { try { await pauseRun(); setMode("minimized"); } catch (e) { showError(e); } });
  $("agentTakeControl").addEventListener("click", () => activateComposer({ takeControl: true }).catch(showError));
  // Pointer activation also permits retrying after a failed resume while focused.
  for (const name of ["focus", "pointerdown"]) $("agentInput").addEventListener(name, () => {
    if (run?.status === "paused") void activateComposer().catch(showError);
  });
  $("agentCancel").addEventListener("click", async () => { try { run = (await request(`/api/agent/runs/${run.id}/cancel`, { controllerId })).run; updateState(run.status); } catch (e) { showError(e); } });
  $("agentComposer").addEventListener("submit", async (event) => {
    event.preventDefault(); const text = $("agentInput").value.trim(); if (!text) return;
    try { if (activation) await activation; if (run?.status === "paused") await activateComposer(); if (!run) await startConversation(); if (!run || $("agentInput").disabled) return; await request(`/api/agent/runs/${run.id}/messages`, { text, controllerId }); composer.setValue(''); updateState("planning"); }
    catch (error) { showError(error); }
  });
  $("agentInput").addEventListener("keydown", (event) => { if (run?.status === "paused" && event.key !== "Tab") void activateComposer().catch(showError); });
  const suggestions = config.demo ? ["Set up demo workspace", "Show my projects"] : ["Help me set up an organization", "Show my projects", "Prepare a localization job"];
  for (const text of suggestions) {
    const button = element("button", "", text); button.type = "button";
    button.addEventListener("click", async () => {
      try {
        if (config.demo && text === "Set up demo workspace" && scope) await startConversation(null);
        composer.setValue(text); $("agentInput").focus();
      } catch (error) { showError(error); }
    }); $("agentSuggestions").append(button);
  }
  $("agentOpaque").addEventListener("click", () => { const opaque = shell.dataset.opaque !== "true"; shell.dataset.opaque = String(opaque); $("agentOpaque").setAttribute("aria-pressed", String(opaque)); const label = opaque ? 'Show workspace edges' : 'Hide workspace edges'; $('agentOpaque').setAttribute('aria-label', label); $('agentOpaque').querySelector('.agent-tool-label').textContent = label; });
  document.addEventListener("input", (event) => { if (event.target.closest("main") && !event.target.closest(".project-languages, .library-workbench, .document-panel") && (event.target.matches("textarea:not([readonly])") || event.target.closest("form"))) dirty = true; });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "Space") { event.preventDefault(); if (mode === "minimized") void openConversation(); else setMode("minimized"); }
    if (event.key === "Escape" && mode === "overlay") { event.preventDefault(); setMode("minimized"); }
    if (event.key === "Tab" && mode === "overlay") {
      const focusable = [...shell.querySelectorAll("a[href],button,input,select,textarea,[tabindex]")].filter((node) => !node.disabled && !node.hidden && node.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  matchMedia("(max-width: 760px)").addEventListener("change", (event) => { setMode(event.matches && mode === "panel" ? "overlay" : mode, false); });
  const saved = sessionStorage.getItem(`hedgeling.agent.run.${userId}`);
  const savedScope = sessionStorage.getItem(scopeKey());
  if (saved && savedScope === null) {
    try {
      await restoreConversation(saved); rememberConversation();
      await refreshScopes(); await workspace.refresh(scope); updateState(run.status); connect();
      $("agentScope").disabled = $("agentNew").disabled = false;
    } catch { run = null; sessionStorage.removeItem(`hedgeling.agent.run.${userId}`); }
  }
  if (!run) {
    // Explicit choices remain explicit, including organizations without a plan.
    // Only a fresh session chooses a chat-eligible default instead of list order.
    const eligible = config.organizations.find(org => org.agentAccess?.allowed !== false && org.chat?.allowed);
    const preferred = savedScope !== null && (!savedScope || config.organizations.some(org => org.id === savedScope))
      ? savedScope || null : config.demo ? null : eligible?.id || config.organizations[0]?.id || null;
    await startConversation(preferred, { restore: true });
  }
  if (hasWorkspace && new URLSearchParams(location.search).has("workspace")) window.HedgelingConsole?.openWorkspace();
  setMode(["overlay", "panel", "minimized"].includes(mode) ? mode : "overlay", false);
}
initialize().then(markInitialized).catch((error) => {
  markInitialized();
  if (error.status === 404) return;
  if (shell.isConnected) { showError(new Error("The assistant could not connect. Reload to retry, or continue manually.")); setMode(mode, false); }
  console.warn("Assistant could not initialize");
});
