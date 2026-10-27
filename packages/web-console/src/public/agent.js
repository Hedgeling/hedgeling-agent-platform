import { renderChatMarkdown } from "./chat-markdown.js";
import { request, element, proposalCard, Workspace, typewriterComposer } from "./agent-components.js";
import { extractionProgress } from './extraction.js';

// A duplicated tab copies sessionStorage. Give every document its own lease
// identity so two tabs can never accidentally share control.
import { AgentAttention, actionForTool } from "./agent-attention.js";

const controllerId = crypto.randomUUID();
let config, brand, run, stream, heartbeat, workspace, userId;
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
const shell = element("section", "agent-shell"); shell.id = "hedgelingAgent"; shell.tabIndex = -1;
shell.innerHTML = `
  <header class="agent-header">
    <div class="agent-identity"><img class="agent-avatar" alt=""><div><strong data-agent-name>Hedgeling</strong><span id="agentStatus" role="status" aria-live="polite">Ready when you are</span></div></div>
    <div class="agent-window-controls" role="group" aria-label="Chat layout">
      <button type="button" data-mode="overlay" aria-label="Full-screen chat" title="Expand chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg><span>Full screen</span></button>
      <button type="button" data-mode="panel" aria-label="Side panel" title="Dock chat beside your workspace"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></svg><span>Side panel</span></button>
      <button type="button" data-mode="minimized" aria-label="Minimize chat" title="Minimize chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18h14"/></svg><span>Minimize</span></button>
    </div>
  </header>
  <div class="agent-context"><label><span>Working in</span><select id="agentScope" aria-label="Conversation organization" disabled></select></label><button type="button" id="agentNew" disabled>New chat</button></div>
  <div id="agentPlanNotice" class="agent-plan-notice" hidden><p id="agentPlanMessage"></p><button type="button" id="agentUpgrade">View plans</button></div>
  <div class="agent-scroll"><div class="agent-paper"><div id="agentWelcome" class="agent-welcome"><img class="agent-hero" alt=""><span class="agent-eyebrow">YOUR LOCALIZATION COPILOT</span><h1>What shall we work on?</h1><p>Build a workspace. Find the right words.<br>Keep every language moving.</p><div id="agentSuggestions" class="agent-suggestions"></div></div><div id="agentMessages" role="log" aria-label="Conversation"></div><div class="agent-paper-end" aria-hidden="true">— to be continued —</div></div></div>
  <div id="agentError" class="agent-error" role="alert"></div>
  <footer class="agent-footer"><div class="agent-run-controls"><button type="button" id="agentPause">Pause</button><button type="button" id="agentTakeover">Take over</button><button type="button" id="agentTakeControl" hidden>Take control</button><button type="button" id="agentCancel">Cancel task</button><label><input type="checkbox" id="agentFollow" checked> Follow along</label></div>
  <p id="agentComposerHint" class="agent-composer-hint" role="status" aria-live="polite" hidden></p>
  ${typewriterComposer}
  <div class="agent-footnote"><span id="agentProviderLabel">You confirm every change.</span><a id="agentCardExamples" href="/agent-preview.html" target="_blank" rel="noopener" hidden>Try card examples ↗</a><label class="agent-theme">Theme <select data-theme-preference><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><button type="button" id="agentOpaque" aria-pressed="false">Hide workspace edges</button><label class="agent-resize">Width <input id="agentWidth" type="range" min="360" max="640" value="480" aria-label="Side panel width"></label></div></footer>`;
const launcher = element("button", "agent-launcher"); launcher.type = "button"; launcher.setAttribute("aria-label", "Open Hedgeling assistant");
launcher.innerHTML = '<img alt=""><span>Ask Hedgeling</span><i aria-hidden="true"></i>';
const $ = (id) => shell.querySelector(`#${id}`);
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
  shell.setAttribute("aria-label", `${brand?.agentName || "Hedgeling"} assistant`);
  if (next === "overlay") shell.setAttribute("aria-modal", "true"); else shell.removeAttribute("aria-modal");
  if (next === "overlay") {
    for (const node of document.body.children) {
      if ([shell, launcher].includes(node) || ["SCRIPT", "LINK", "STYLE"].includes(node.tagName)) continue;
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
}
function updateState(status) {
  if (run) run.status = status;
  if (["paused", "cancelled", "failed"].includes(status)) { attentionGeneration++; attention.clear(); }
  const labels = { awaiting_input: "Ready when you are", planning: "Planning the next step", reading: "Looking at your workspace", awaiting_confirmation: "Waiting for your confirmation", paused: "Paused · You’re in control", cancelled: "Task cancelled", completed: "All done", executing: "Applying your confirmed change" };
  $("agentStatus").textContent = labels[status] || status;
  launcher.dataset.status = status;
  launcher.setAttribute("aria-label", `Open ${brand?.agentName || "Hedgeling"} assistant. ${labels[status] || status}`);
  const paused = status === "paused";
  const otherController = run?.controllerId && run.controllerId !== controllerId && status !== "cancelled";
  if (otherController) $("agentStatus").textContent = "Viewing conversation · Take control to continue";
  $("agentTakeControl").hidden = !otherController; $("agentPause").hidden = paused;
  const chat = scopeChat();
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
  $("agentInput").setAttribute("aria-describedby", "agentComposerHint");
  $("agentInput").placeholder = otherController ? "Select Take control above…" : paused ? "Click here to continue chatting…" : "Type your next idea…";
  $("agentComposer").querySelector("button").disabled = $("agentInput").disabled || paused || Boolean(activation);
  $("agentPause").disabled = !run; $("agentCancel").disabled = !run || status === "cancelled";
  for (const button of shell.querySelectorAll(".agent-proposal button")) button.disabled = !chat.allowed || otherController || status !== "awaiting_confirmation";
}
function message(role, text, { replay = false } = {}) {
  $("agentWelcome").hidden = true;
  const item = element("article", `agent-message agent-message-${role}`);
  const content = element("div", "agent-message-content");
  if (role === "user") { const paragraph = element("p", "", text); content.append(paragraph); }
  else content.append(renderChatMarkdown(text));
  // Reveal formatted content as a whole: never flash raw Markdown markers.
  if (role !== "user" && !replay) content.classList.add("agent-ink-reveal");
  item.append(element("span", "agent-message-author", role === "user" ? "You" : brand.agentName), content);
  $("agentMessages").append(item);
}
async function follow(target, { phase = "working", card, label = "Looking at this section" } = {}) {
  const generation = ++attentionGeneration;
  if (!target || !$("agentFollow").checked || ["paused", "cancelled"].includes(run?.status)) return;
  if (dirty) { await pauseRun(); showError(new Error("Your unsaved edits are still on screen. Save them before resuming the agent.")); return; }
  if (target.view === "workspace") {
    await workspace.refresh(target.organizationId, target.resource?.type === "job" ? target.resource.id : null);
    if (generation !== attentionGeneration || !$("agentFollow").checked || ["paused", "cancelled"].includes(run?.status)) return;
    window.HedgelingConsole?.openWorkspace();
    attention.show({ action: target.action || "read", resource: target.resource, phase, card, label });
  }
}
function receive(item, { replay = false } = {}) {
  if (seen.has(String(item.sequence))) return;
  seen.add(String(item.sequence)); cursor = Math.max(cursor, Number(item.sequence));
  const { kind, data } = item;
  if (kind === "commercial_access") { const chat = scopeChat(); chat.allowed = false; chat.message = data.message; updateState(run?.status || "paused"); }
  if (kind === "message") message(data.role, data.text, { replay });
  if (kind === "activity") {
    const line = element("p", "agent-activity", `${data.status === "complete" ? "✓ " : "· "}${data.label}`);
    $("agentMessages").append(line);
    if (!replay && data.status === "working" && actionForTool(data.tool)) void follow({ view: "workspace", organizationId: scope, action: actionForTool(data.tool) }, { label: data.label }).catch(showError);
    if (!replay && data.status === "failed") { attentionGeneration++; attention.clear(); }
  }
  if (kind === "state") { if (run && Object.hasOwn(data, "controllerId")) run.controllerId = data.controllerId; if (data.organizationId) { scope = data.organizationId; if (run) run.organizationId = scope; void refreshScopes(); } updateState(data.status); }
  if (kind === "proposal" && !confirmed.has(data.id) && !shell.querySelector(`[data-proposal-id="${data.id}"]`)) {
    $("agentWelcome").hidden = true;
    $("agentMessages").append(proposalCard(data, async (proposal) => {
      if ($("agentFollow").checked) attention.show({ action: proposal.preview.action, phase: "working", label: "Applying your confirmed change", card: shell.querySelector(`[data-proposal-id="${proposal.id}"]`) });
      const result = await request(`/api/agent/proposals/${proposal.id}/confirm`, { fingerprint: proposal.fingerprint, controllerId });
      confirmed.add(proposal.id); scope = result.result.uiTarget.organizationId;
      await refreshScopes(); await workspace.refresh(scope, result.result.job?.id); await window.HedgelingConsole?.refresh();
      await follow(result.result.uiTarget, { phase: "complete", label: proposal.preview.action.endsWith(".update") ? "Updated · ready to inspect" : "Created · ready to inspect" });
      if (run?.status !== "paused") await request(`/api/agent/runs/${run.id}/continue`, { controllerId });
    }, async (proposal) => { await request(`/api/agent/proposals/${proposal.id}/reject`, { controllerId }); }));
    if (!replay) void follow(data.uiTarget || { view: "workspace", organizationId: scope, action: data.preview.action }, { phase: "approval", card: shell.querySelector(`[data-proposal-id="${data.id}"]`), label: "Your approval is needed here" }).catch(showError);
  }
  if (kind === "result") {
    confirmed.add(data.proposalId);
    const card = shell.querySelector(`[data-proposal-id="${data.proposalId}"]`);
    if (card) card.replaceChildren(element("p", "agent-receipt", "✓ Change confirmed"));
    const resource = data.organization || data.businessUnit || data.project || data.job;
    if (resource) message("assistant", data.uiTarget?.action?.endsWith(".update") ? `${resource.name} has been updated.` : `${resource.name} is ready${data.job ? " as a draft" : ""}.`, { replay });
    if (data.extraction) $("agentMessages").append(extractionProgress({ projectSlug: data.extraction.projectSlug, extractionId: data.extraction.id, request,
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
  const scroller = shell.querySelector(".agent-scroll"); scroller.scrollTop = scroller.scrollHeight;
}
function connect() {
  if (!run) return;
  stream?.close(); clearInterval(heartbeat);
  stream = new EventSource(`/api/agent/runs/${run.id}/events?after=${cursor}&controllerId=${controllerId}`);
  stream.onmessage = (event) => { try { receive(JSON.parse(event.data)); } catch { showError(new Error("Could not read an activity update. Reload the conversation.")); } };
  stream.addEventListener("access_changed", () => { stream.close(); clearInterval(heartbeat); showError(new Error("Your access changed. Start a new conversation.")); updateState("paused"); });
  stream.onerror = () => { $("agentStatus").textContent = "Connection interrupted · Reconnecting"; };
  heartbeat = setInterval(() => { if (run?.controllerId === controllerId && run.status !== "paused") void request(`/api/agent/runs/${run.id}/heartbeat`, { controllerId }).catch((error) => { updateState("paused"); showError(error); }); }, 8000);
}
async function refreshScopes() {
  config = await request("/api/agent/config");
  window.HedgelingShell?.agentAvailable(config, brand);
  const select = $("agentScope"); select.replaceChildren(new Option("New organization", ""));
  for (const org of config.organizations) select.append(new Option(org.name, org.id));
  select.value = scope || "";
  updateState(run?.status || "awaiting_input");
}
async function startConversation(organizationId = scope) {
  if (switching) return; switching = true;
  $("agentScope").disabled = $("agentNew").disabled = true;
  try {
    if (run && !["paused", "cancelled"].includes(run.status)) {
      try { await pauseRun(); } catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    stream?.close(); clearInterval(heartbeat); scope = organizationId;
    run = null; await refreshScopes();
    run = config.ready && scopeChat().allowed ? (await request("/api/agent/runs", { organizationId: scope, controllerId })).run : null;
    if (run) sessionStorage.setItem(`hedgeling.agent.run.${userId}`, run.id);
    else sessionStorage.removeItem(`hedgeling.agent.run.${userId}`);
    attentionGeneration++; attention.clear();
    cursor = 0; seen.clear(); confirmed.clear(); $("agentMessages").replaceChildren(); $("agentWelcome").hidden = false; $("agentError").textContent = "";
    await refreshScopes(); await workspace.refresh(scope); updateState(run?.status || "awaiting_input"); connect();
  } finally { switching = false; $("agentScope").disabled = $("agentNew").disabled = false; updateState(run?.status || "awaiting_input"); }
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
    if (dirty) $("agentFollow").checked = false;
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
  shell.append(attention.status);
  window.HedgelingTheme?.syncControls();
  $("agentCardExamples").hidden = !config.demo;
  for (const image of [shell.querySelector(".agent-avatar"), shell.querySelector(".agent-hero"), launcher.querySelector("img")]) image.src = brand.mascot;
  for (const node of shell.querySelectorAll("[data-agent-name]")) node.textContent = brand.agentName;
  launcher.querySelector("span").textContent = `Ask ${brand.agentName}`;
  for (const logo of document.querySelectorAll(".brand-logo")) logo.src = brand.logo;
  $("agentProviderLabel").textContent = config.demo ? "Local demo · Real changes still need confirmation" : "You confirm every change.";
  if (!config.ready) showError(new Error("The assistant is currently unavailable. You can use the workspace manually."));
  workspace = new Workspace(document.getElementById("workspaceRoot"), controllerId, async (id, jobId) => { await refreshScopes(); await workspace.refresh(id, jobId); });
  window.HedgelingAgent = {
    open() { setMode("panel"); },
    async browseWorkspace(id) { await initialized; await workspace.refresh(id); },
    async showProjects() { await initialized; await workspace.refresh(workspace.organizationId || config.organizations[0]?.id || null); },
  };
  window.HedgelingShell?.agentAvailable(config, brand);
  document.addEventListener("hedgeling:manual-navigation", () => { $("agentFollow").checked = false; attentionGeneration++; attention.clear(); });
  $("agentFollow").addEventListener("change", () => { if (!$("agentFollow").checked) { attentionGeneration++; attention.clear(); } });
  for (const button of shell.querySelectorAll("[data-mode]")) button.addEventListener("click", () => setMode(button.dataset.mode));
  launcher.addEventListener("click", () => setMode("panel"));
  $("agentNew").addEventListener("click", () => startConversation().catch(showError));
  $("agentScope").addEventListener("change", () => startConversation($("agentScope").value || null).catch(showError));
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
    try { if (activation) await activation; if (run?.status === "paused") await activateComposer(); if (!run) await startConversation(); if (!run || $("agentInput").disabled) return; await request(`/api/agent/runs/${run.id}/messages`, { text, controllerId }); $("agentInput").value = ""; updateState("planning"); }
    catch (error) { showError(error); }
  });
  $("agentInput").addEventListener("keydown", (event) => { if (run?.status === "paused" && event.key !== "Tab") void activateComposer().catch(showError); if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("agentInput").disabled) $("agentComposer").requestSubmit(); } });
  const suggestions = config.demo ? ["Set up demo workspace", "Show my projects"] : ["Help me set up an organization", "Show my projects", "Prepare a localization job"];
  for (const text of suggestions) {
    const button = element("button", "", text); button.type = "button";
    button.addEventListener("click", async () => {
      try {
        if (config.demo && text === "Set up demo workspace" && scope) await startConversation(null);
        $("agentInput").value = text; $("agentInput").focus();
      } catch (error) { showError(error); }
    }); $("agentSuggestions").append(button);
  }
  $("agentOpaque").addEventListener("click", () => { const opaque = shell.dataset.opaque !== "true"; shell.dataset.opaque = String(opaque); $("agentOpaque").setAttribute("aria-pressed", String(opaque)); });
  $("agentWidth").addEventListener("input", (event) => document.documentElement.style.setProperty("--agent-panel-width", `${Number(event.target.value)}px`));
  document.addEventListener("input", (event) => { if (event.target.closest("main") && (event.target.matches("textarea:not([readonly])") || event.target.closest("form"))) dirty = true; });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "Space") { event.preventDefault(); setMode(mode === "minimized" ? "panel" : "minimized"); }
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
  if (saved) {
    try {
      const restored = await request(`/api/agent/runs/${saved}`); run = { ...restored.run }; scope = run.organizationId;
      for (const item of restored.events) if (item.kind === "result") confirmed.add(item.data.proposalId);
      for (const item of restored.events) receive(item, { replay: true });
      run = restored.run; updateState(run.status); await refreshScopes(); await workspace.refresh(scope); connect();
      $("agentScope").disabled = $("agentNew").disabled = false;
    } catch { run = null; sessionStorage.removeItem(`hedgeling.agent.run.${userId}`); }
  }
  if (!run) await startConversation(scope || (config.demo ? null : config.organizations[0]?.id || null));
  if (hasWorkspace && new URLSearchParams(location.search).has("workspace")) window.HedgelingConsole?.openWorkspace();
  setMode(["overlay", "panel", "minimized"].includes(mode) ? mode : "overlay", false);
}
initialize().then(markInitialized).catch((error) => {
  markInitialized();
  if (error.status === 404) return;
  if (shell.isConnected) { showError(new Error("The assistant could not connect. Reload to retry, or continue manually.")); setMode("panel", false); }
  console.warn("Assistant could not initialize");
});
