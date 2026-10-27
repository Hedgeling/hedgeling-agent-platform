const commercialConsole = import("./commercial.js");
const fallbackLocales = [
  "en-GB",
  "en-AU",
  "en-CA",
  "fr-CA",
  "en-IN",
  "hi-IN",
  "nl-NL",
  "sv-SE",
  "pl-PL",
  "uk-UA",
  "ru-RU",
  "es-ES",
];

let locales = fallbackLocales;
let selectedLocale = "es-ES";
let projects = [];
let selectedProjectSlug = localStorage.getItem("hedgeling.console.project") || "scroll-goblin";
let selectedStringId = null;
let selectedDetail = null;
// dynamic-data spec 08: review triage. The default queue view is UI strings
// only — dynamic volume must never bury the strings a human MUST review.
// Data-source facets use the server's `source:<name>` escape so a source
// literally named "ui" or "all" stays reachable.
let selectedSourceFacet = "ui";
let enumGridFields = [];

function selectedFacetSourceName() {
  return selectedSourceFacet.startsWith("source:")
    ? selectedSourceFacet.slice("source:".length)
    : null;
}
let selectedView = "home";
let promptCache = [];
let glossaryCache = [];
let personaCache = [];
let projectPermissionSet = new Set();
let accessOrganizations = [];
let accessState = null;
let accessPermissionSet = new Set();
let usageState = null;
let budgetState = null;
let vendorRelationshipState = [];
let personalWorkState = [];
let selectedWorkAssignmentId = null;
let selectedWorkItems = [];
let identityState = null;
let serviceAccountState = [];
let scimTokenState = [];
let accessReviewState = [];
let accessRequestState = [];
let governanceReportState = null;
let selectedAccessReviewId = null;
let currentAuth = null;
let paymentProgramState = null;
let payoutAccountState = null;
let paymentOperationsState = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[ch]);
}

function jsonText(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function debounce(fn, delay = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

async function api(path, options = {}) {
  let res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (res.status === 401 && path !== "/api/auth/refresh") {
    const refreshed = await fetch("/api/auth/refresh", { method: "POST" });
    if (refreshed.ok) {
      res = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...options,
      });
    } else {
      location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      throw new Error("Your session has expired");
    }
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function signOut() {
  await fetch("/api/auth/refresh/logout", { method: "POST" });
  location.assign("/login");
}

async function acceptInvitationFromUrl() {
  const url = new URL(location.href);
  const token = url.searchParams.get("invitation");
  if (!token) return;
  await api("/api/access/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  url.searchParams.delete("invitation");
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  toast("Invitation accepted", "good");
}

function projectParams(extra = {}) {
  return new URLSearchParams({ project: selectedProjectSlug, ...extra });
}

function projectPath(path, extra = {}) {
  const params = projectParams(extra);
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${params}`;
}

function toast(message, tone = "neutral") {
  const node = $("toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

function statusClass(status) {
  if (status === "verified" || status === "ready") return "good";
  if (status === "degraded" || status === "missing" || status === "needs-review") return "warn";
  if (status === "stub" || status === "rejected") return "bad";
  return "neutral";
}

function badge(label, tone = "neutral") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

// ---- dynamic-data spec 08: typed placeholder chips ------------------------------
// Masked templates render placeholders as typed chips ({0:currency}), not raw
// {0}. Mirrors src/review-triage.js tokenizeChips — chips are atomic tokens;
// the textarea keeps the raw {N} text so an edit round-trips byte-exact.

const CHIP_RE = /\{(\d+)\}/g;

function tokenizeChips(text, maskNames = []) {
  const value = String(text ?? "");
  const tokens = [];
  let last = 0;
  for (const match of value.matchAll(CHIP_RE)) {
    if (match.index > last) tokens.push({ type: "text", value: value.slice(last, match.index) });
    const index = Number(match[1]);
    tokens.push({ type: "chip", value: match[0], index, mask: maskNames[index] ?? null });
    last = match.index + match[0].length;
  }
  if (last < value.length) tokens.push({ type: "text", value: value.slice(last) });
  return tokens;
}

function chipLabel(token) {
  return token.mask ? `{${token.index}:${token.mask}}` : token.value;
}

function chippedHtml(text, maskNames, missingChips = []) {
  return tokenizeChips(text, maskNames).map((token) => {
    if (token.type === "text") return escapeHtml(token.value);
    const missing = missingChips.includes(token.value) ? " missing" : "";
    return `<span class="chip${missing}">${escapeHtml(chipLabel(token))}</span>`;
  }).join("");
}

// Chip mismatch between source and translation: a translation missing a chip
// is visually obvious before the validator even runs.
function chipMismatch(sourceText, translationText) {
  const counts = (text) => {
    const map = new Map();
    for (const token of tokenizeChips(text)) {
      if (token.type === "chip") map.set(token.value, (map.get(token.value) ?? 0) + 1);
    }
    return map;
  };
  const expected = counts(sourceText);
  const actual = counts(translationText);
  const missing = [...expected.keys()].filter((chip) => (actual.get(chip) ?? 0) < expected.get(chip)).sort();
  const extra = [...actual.keys()].filter((chip) => (expected.get(chip) ?? 0) < actual.get(chip)).sort();
  return { missing, extra, ok: missing.length === 0 && extra.length === 0 };
}

function isPlatformHuman() {
  return Boolean(
    currentAuth?.user?.id
    && (currentAuth.platformAdmin === true || currentAuth.user.platformStaff === true),
  );
}

function isPlatformAdminClient() {
  return Boolean(currentAuth?.platformAdmin === true || currentAuth?.user?.platformStaff === true);
}

function canViewPlatformPayments() {
  return isPlatformAdminClient() || currentAuth?.platformOperations?.view === true;
}

function minorUnitsToUsd(value) {
  if (value == null || !/^[0-9]+$/.test(String(value))) return "";
  const amount = BigInt(value);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}

function usdToMinorUnits(value) {
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(String(value || "").trim());
  if (!match || BigInt(match[1]) === 0n && !Number(match[2] || 0)) {
    throw new Error("USD caps must be positive amounts with at most two decimal places");
  }
  return String(BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0"));
}

function populateSelect(select, values, selected) {
  select.innerHTML = values.map((locale) => `<option value="${escapeHtml(locale)}">${escapeHtml(locale)}</option>`).join("");
  select.value = values.includes(selected) ? selected : values[0] || "";
}

function populateProjectSelect() {
  const select = $("project");
  select.innerHTML = projects
    .map((project) => `<option value="${escapeHtml(project.slug)}">${escapeHtml(project.name)}</option>`)
    .join("");
  select.value = projects.some((project) => project.slug === selectedProjectSlug)
    ? selectedProjectSlug
    : projects[0]?.slug || "scroll-goblin";
  selectedProjectSlug = select.value;
  localStorage.setItem("hedgeling.console.project", selectedProjectSlug);
}

function hasProjectPermission(permission) {
  return projectPermissionSet.has(permission);
}

function hasAccessPermission(permission) {
  return accessPermissionSet.has(permission);
}

function syncConsoleShell() {
  window.HedgelingShell?.update({
    view: selectedView, projects, projectSlug: selectedProjectSlug,
    organizations: accessOrganizations, permissions: [...projectPermissionSet],
    assignments: personalWorkState, user: currentAuth?.user,
    canOperate: canViewPlatformPayments(),
  });
}

function canVisitView(view) {
  const permission = { review: "strings.view", prompts: "prompts.view", glossary: "glossary.view", personas: "personas.view" }[view];
  if (permission) return hasProjectPermission(permission);
  if (view === "library") return ["prompts.view", "glossary.view", "personas.view"].some(hasProjectPermission);
  if (view === "access") return accessOrganizations.length > 0;
  if (view === "operations") return canViewPlatformPayments();
  return ["home", "workspace", "work"].includes(view);
}

function applyPermissionVisibility() {
  document.querySelectorAll("[data-requires]").forEach((node) => {
    node.hidden = !hasAccessPermission(node.dataset.requires);
  });
  $("saveTranslation").hidden = !hasProjectPermission("translations.approve");
  $("approveTranslation").hidden = !hasProjectPermission("translations.approve");
  $("rejectTranslation").hidden = !hasProjectPermission("translations.approve");
  $("reviseTranslation").hidden = !hasProjectPermission("translations.edit");
  $("translationText").readOnly = !hasProjectPermission("translations.edit")
    && !hasProjectPermission("translations.approve");
  syncConsoleShell();
}

async function loadProject() {
  const projectData = await api("/api/projects");
  projects = projectData.projects || [];
  populateProjectSelect();
  const hasProject = projects.length > 0;
  // Project selection is presented by the workspace picker.
  $("locale").closest("label").hidden = !hasProject;
  if (!hasProject) {
    projectPermissionSet = new Set();
    applyPermissionVisibility();
    return false;
  }
  const [project, localeData] = await Promise.all([
    api(projectPath("/api/projects/default")),
    api(projectPath("/api/locales")),
  ]);
  const enabledLocales = localeData.locales.filter((item) => item.enabled).map((item) => item.locale);
  locales = enabledLocales.length ? enabledLocales : fallbackLocales;
  if (!locales.includes(selectedLocale)) selectedLocale = locales[0] || selectedLocale;
  const permissionData = await api(`/api/projects/${encodeURIComponent(selectedProjectSlug)}/permissions?locale=${encodeURIComponent(selectedLocale)}`);
  projectPermissionSet = new Set(permissionData.permissions || []);
  applyPermissionVisibility();
  populateSelect($("locale"), locales, selectedLocale);
  populateSelect($("personaLocale"), locales, selectedLocale);
  return true;
}

function accessPath(path = "") {
  const organizationId = $("accessOrganization").value;
  return `/api/access/organizations/${encodeURIComponent(organizationId)}${path}`;
}

async function loadAccessOrganizations() {
  const selected = $("accessOrganization").value;
  const data = await api("/api/access/organizations");
  accessOrganizations = (data.organizations || []).filter((o) => o.permissions.includes("organization.view"));
  $("accessOrganization").innerHTML = optionList(accessOrganizations, "id", (o) => o.name);
  if (accessOrganizations.some((o) => o.id === selected)) $("accessOrganization").value = selected;
}

function optionList(items, valueKey, label) {
  return items.map((item) => `<option value="${escapeHtml(item[valueKey])}">${escapeHtml(label(item))}</option>`).join("");
}

function dateTimeInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16);
}

function dateInputValue(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function currentDateInputValue() {
  const local = new Date();
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
}

function accessName(principalType, principalId) {
  if (principalType === "team") return accessState?.teams.find((item) => item.id === principalId)?.name || "Unknown team";
  if (principalType === "service_account") {
    return accessState?.serviceAccounts?.find((item) => item.id === principalId)?.name || "Unknown service account";
  }
  const member = accessState?.members.find((item) => item.userId === principalId);
  return member?.displayName || member?.email || "Unknown member";
}

function scopeName(scopeType, scopeId) {
  if (scopeType === "organization") return accessState?.organization.name || "Organization";
  if (scopeType === "project") return accessState?.projects.find((item) => item.id === scopeId)?.name || "Project";
  return accessState?.businessUnits.find((item) => item.id === scopeId)?.name || scopeType;
}

function formatQuantity(value) {
  try {
    return BigInt(value || 0).toLocaleString();
  } catch {
    return String(value || 0);
  }
}

function budgetScopeName(item) {
  if (item.scopeType === "organization") return accessState?.organization.name || "Organization";
  if (item.scopeType === "business_unit") {
    return item.businessUnitName
      || accessState?.businessUnits.find((unit) => unit.id === item.businessUnitId)?.name
      || "Business unit";
  }
  return item.projectName
    || accessState?.projects.find((project) => project.id === item.projectId)?.name
    || "Project";
}

function renderUsageAndBudgets() {
  if (!usageState || !budgetState) return;
  const metricMap = new Map(budgetState.metrics.map((metric) => [metric.key, metric]));
  const from = new Date(usageState.window.from);
  const to = new Date(usageState.window.to);
  $("usageWindow").textContent = `${from.toLocaleDateString()}–${to.toLocaleDateString()} · ${usageState.window.basis.replaceAll("_", " ")}`;
  $("usageMetrics").innerHTML = (usageState.totals || []).map((total) => {
    const metric = metricMap.get(total.metricKey);
    return `
      <div class="usage-metric">
        <strong>${escapeHtml(formatQuantity(total.quantity))}</strong>
        <span>${escapeHtml(metric?.name || total.metricKey)}</span>
      </div>
    `;
  }).join("") || '<div class="list-empty">No metered usage in this period.</div>';

  $("budgetMetric").innerHTML = optionList(
    budgetState.metrics,
    "key",
    (metric) => `${metric.name} (${metric.unit})`,
  );
  updateBudgetScopes();
  $("budgetList").innerHTML = (budgetState.budgets || []).map((budget) => `
    <div class="budget-row" data-state="${escapeHtml(budget.state)}">
      <div class="budget-row-head">
        <div>
          <strong>${escapeHtml(budget.metricName)}</strong>
          <small>${escapeHtml(budgetScopeName(budget))} · ${escapeHtml(budget.period.replaceAll("_", " "))}</small>
        </div>
        ${badge(budget.state, budget.state === "within" ? "good" : budget.state === "warning" ? "warn" : "bad")}
      </div>
      <progress value="${escapeHtml(budget.percentUsed)}" max="100">${escapeHtml(budget.percentUsed)}%</progress>
      <div class="budget-amount">
        <span>${escapeHtml(formatQuantity(budget.usedQuantity))} used${BigInt(budget.heldQuantity || 0) ? ` + ${escapeHtml(formatQuantity(budget.heldQuantity))} pending` : ""}</span>
        <span>${escapeHtml(formatQuantity(budget.limitQuantity))} limit</span>
      </div>
      <small>${escapeHtml(budget.enforcement)} at limit · warn at ${escapeHtml(budget.warningPercent)}% · ${escapeHtml(budget.reason)}</small>
      ${hasAccessPermission("budgets.manage") ? `<button class="budget-remove danger" data-id="${escapeHtml(budget.id)}" type="button">Remove budget</button>` : ""}
    </div>
  `).join("") || '<div class="list-empty">No active budgets.</div>';

  $("budgetAlertList").innerHTML = (budgetState.alerts || []).map((alert) => `
    <div class="budget-alert" data-threshold="${escapeHtml(alert.threshold)}">
      <div>
        <strong>${escapeHtml(alert.threshold)} · ${escapeHtml(metricMap.get(alert.metricKey)?.name || alert.metricKey)}</strong>
        <small>${escapeHtml(budgetScopeName(alert))} · ${escapeHtml(new Date(alert.createdAt).toLocaleString())}</small>
      </div>
      <span>${escapeHtml(formatQuantity(alert.observedQuantity))}</span>
      ${alert.acknowledgedAt
        ? badge("acknowledged", "neutral")
        : hasAccessPermission("budgets.manage")
          ? `<button class="budget-alert-ack" data-id="${escapeHtml(alert.id)}" type="button">Acknowledge</button>`
          : badge("open", "warn")}
    </div>
  `).join("") || '<div class="list-empty">No budget alerts.</div>';
}

async function loadUsageAndBudgets() {
  if (!hasAccessPermission("usage.view")) return;
  [usageState, budgetState] = await Promise.all([
    api(accessPath("/usage")),
    api(accessPath("/budgets")),
  ]);
  renderUsageAndBudgets();
}

function vendorStatusTone(status) {
  if (status === "active") return "good";
  if (status === "invited" || status === "onboarding") return "warn";
  if (status === "suspended") return "bad";
  return "neutral";
}

function commaSeparated(values) {
  return values.map((value) => value.scopeValue).filter(Boolean).join(", ");
}

function vendorTransitionButtons(relationship, party) {
  const actions = [];
  if (party === "agency" && relationship.status === "invited") {
    actions.push(["onboarding", "Accept relationship", "primary"]);
  }
  if (party === "customer" && relationship.status === "onboarding") {
    actions.push(["active", "Activate", "primary"]);
  }
  if (party === "customer" && relationship.status === "active") {
    actions.push(["suspended", "Suspend", ""]);
  }
  if (party === "customer" && relationship.status === "suspended") {
    actions.push(["active", "Reactivate", "primary"]);
  }
  if (relationship.status !== "terminated") {
    actions.push(["terminated", "Terminate", "danger"]);
  }
  return actions.map(([status, label, className]) => `
    <button type="button" class="vendor-transition ${className}" data-status="${status}">
      ${escapeHtml(label)}
    </button>
  `).join("");
}

function vendorScopeOptions(detail) {
  const selected = new Set(
    detail.scopes
      .filter((scope) => scope.scopeId)
      .map((scope) => `${scope.scopeType}|${scope.scopeId}`),
  );
  return [
    ...accessState.businessUnits.map((unit) => ({
      value: `business_unit|${unit.id}`,
      label: `BU · ${unit.name}`,
    })),
    ...accessState.projects.map((project) => ({
      value: `project|${project.id}`,
      label: `Project · ${project.name}`,
    })),
  ].map((option) => `
    <option value="${escapeHtml(option.value)}" ${selected.has(option.value) ? "selected" : ""}>
      ${escapeHtml(option.label)}
    </option>
  `).join("");
}

function rateCardStatusTone(status) {
  if (status === "approved") return "good";
  if (status === "submitted") return "warn";
  if (status === "rejected") return "bad";
  return "neutral";
}

function vendorRateBusinessUnits(detail) {
  const units = new Map();
  detail.scopes
    .filter((scope) => scope.scopeType === "business_unit" && scope.scopeId)
    .forEach((scope) => units.set(scope.scopeId, scope.scopeName || scope.scopeId));
  (detail.eligibleProjects || []).forEach((project) => (
    units.set(project.businessUnitId, project.businessUnitName || project.businessUnitId)
  ));
  return [...units].map(([id, name]) => ({ id, name }));
}

function rateCardLineRow(detail, line = {}) {
  const businessUnits = vendorRateBusinessUnits(detail);
  const projectsForRate = detail.eligibleProjects || [];
  const unitTypes = [
    ["source_word", "Source word"],
    ["target_word", "Target word"],
    ["character", "Character"],
    ["string", "String"],
    ["hour", "Hour"],
    ["fixed_job", "Fixed job"],
  ];
  return `
    <div class="rate-line-row">
      <label><span>Service</span><input name="serviceType" maxlength="100" value="${escapeHtml(line.serviceType || "translation")}" required></label>
      <label>
        <span>Unit</span>
        <select name="unitType">
          ${unitTypes.map(([value, label]) => `
            <option value="${value}" ${line.unitType === value || (!line.unitType && value === "source_word") ? "selected" : ""}>${label}</option>
          `).join("")}
        </select>
      </label>
      <label><span>Rate</span><input name="unitRate" inputmode="decimal" value="${escapeHtml(line.unitRate ?? "")}" placeholder="0.12" required></label>
      <label><span>Source locale</span><input name="sourceLocale" value="${escapeHtml(line.sourceLocale || "")}" placeholder="en-US"></label>
      <label><span>Target locale</span><input name="targetLocale" value="${escapeHtml(line.targetLocale || "")}" placeholder="fr-CA"></label>
      <label>
        <span>Business unit</span>
        <select name="businessUnitId">
          <option value="">All eligible BUs</option>
          ${businessUnits.map((unit) => `
            <option value="${escapeHtml(unit.id)}" ${line.businessUnitId === unit.id ? "selected" : ""}>${escapeHtml(unit.name)}</option>
          `).join("")}
        </select>
      </label>
      <label>
        <span>Project</span>
        <select name="projectId">
          <option value="">All eligible projects</option>
          ${projectsForRate.map((project) => `
            <option value="${escapeHtml(project.id)}"
                    data-business-unit-id="${escapeHtml(project.businessUnitId)}"
                    ${line.projectId === project.id ? "selected" : ""}>
              ${escapeHtml(`${project.businessUnitName} · ${project.name}`)}
            </option>
          `).join("")}
        </select>
      </label>
      <label><span>Content type</span><input name="contentType" value="${escapeHtml(line.contentType || "")}" placeholder="game-ui"></label>
      <label><span>Match band</span><input name="matchBand" value="${escapeHtml(line.matchBand || "")}" placeholder="new"></label>
      <label><span>Minimum units</span><input name="minimumUnits" inputmode="decimal" value="${escapeHtml(line.minimumUnits ?? "")}"></label>
      <button class="rate-line-remove danger" type="button">Remove</button>
    </div>
  `;
}

function rateCardForm(detail, card = null) {
  const relationship = detail.vendorRelationship;
  const lines = card?.lines?.length ? card.lines : [{}];
  return `
    <form class="rate-card-form" ${card ? `data-rate-card-id="${escapeHtml(card.id)}"` : ""}>
      <div class="rate-card-fields">
        <label><span>Currency</span><input name="currency" maxlength="3" value="${escapeHtml(card?.currency || relationship.defaultCurrency)}" required></label>
        <label><span>Payment terms</span><input name="paymentTermsDays" type="number" min="0" step="1" value="${escapeHtml(card?.paymentTermsDays ?? relationship.paymentTermsDays ?? 30)}"></label>
        <label><span>Effective from</span><input name="effectiveFrom" type="date" value="${escapeHtml(dateInputValue(card?.effectiveFrom) || currentDateInputValue())}"></label>
        <label><span>Effective to</span><input name="effectiveTo" type="date" value="${escapeHtml(dateInputValue(card?.effectiveTo))}"></label>
        <label><span>Minimum charge (minor units)</span><input name="minimumChargeMinor" type="number" min="0" step="1" value="${escapeHtml(card?.minimumChargeMinor ?? "")}"></label>
        <label class="rate-card-notes"><span>Notes</span><textarea name="notes" maxlength="2000">${escapeHtml(card?.notes || "")}</textarea></label>
      </div>
      <div class="rate-line-list">
        ${lines.map((line) => rateCardLineRow(detail, line)).join("")}
      </div>
      <div class="rate-card-form-actions">
        <button class="rate-line-add" type="button">Add rate line</button>
        <button class="primary" type="submit">${card ? "Save draft" : "Create draft"}</button>
      </div>
    </form>
  `;
}

function rateCardScopeLabel(detail, line) {
  const project = (detail.eligibleProjects || []).find((item) => item.id === line.projectId);
  if (project) return `${project.businessUnitName} · ${project.name}`;
  const businessUnit = vendorRateBusinessUnits(detail).find((item) => item.id === line.businessUnitId);
  return businessUnit?.name || "All eligible work";
}

function renderRateCards(detail, party) {
  if (!hasAccessPermission("rate_cards.view")) return "";
  const relationship = detail.vendorRelationship;
  const rateCards = detail.rateCards || [];
  const canPropose = party === "agency"
    && hasAccessPermission("rate_cards.propose")
    && ["onboarding", "active"].includes(relationship.status);
  const canApprove = party === "customer"
    && hasAccessPermission("rate_cards.approve")
    && ["onboarding", "active"].includes(relationship.status);
  const openCard = rateCards.find((card) => ["draft", "submitted"].includes(card.status));
  return `
    <section class="vendor-rate-cards">
      <div class="rate-card-heading">
        <div>
          <h3>Rate cards</h3>
          <p>Agency-proposed pricing. Customer approval creates the current commercial version.</p>
        </div>
        ${canPropose && !openCard ? `
          <button class="rate-card-create-toggle" type="button">New proposal</button>
        ` : ""}
      </div>
      ${canPropose && !openCard ? `
        <details class="vendor-editor rate-card-create-editor">
          <summary>Create a rate-card draft</summary>
          ${rateCardForm(detail)}
        </details>
      ` : ""}
      <div class="rate-card-list">
        ${rateCards.map((card) => `
          <article class="rate-card" data-rate-card-id="${escapeHtml(card.id)}">
            <header>
              <div>
                <strong>Version ${escapeHtml(card.version)} · ${escapeHtml(card.currency)}</strong>
                <small>
                  ${escapeHtml(card.effectiveFrom || "No start")} – ${escapeHtml(card.effectiveTo || "Open-ended")}
                  · Net ${escapeHtml(card.paymentTermsDays ?? "—")}
                </small>
              </div>
              ${badge(card.status, rateCardStatusTone(card.status))}
            </header>
            ${card.status === "draft" && canPropose ? rateCardForm(detail, card) : `
              <div class="rate-card-lines">
                ${(card.lines || []).map((line) => `
                  <div class="rate-card-line">
                    <div>
                      <strong>${escapeHtml(line.serviceType)} · ${escapeHtml(line.sourceLocale || "any")} → ${escapeHtml(line.targetLocale || "any")}</strong>
                      <small>${escapeHtml(rateCardScopeLabel(detail, line))}${line.contentType ? ` · ${escapeHtml(line.contentType)}` : ""}${line.matchBand ? ` · ${escapeHtml(line.matchBand)}` : ""}</small>
                    </div>
                    <span>${escapeHtml(line.unitRate)} / ${escapeHtml(line.unitType.replaceAll("_", " "))}</span>
                  </div>
                `).join("") || '<div class="list-empty">No pricing lines.</div>'}
              </div>
              ${card.notes ? `<p class="rate-card-note">${escapeHtml(card.notes)}</p>` : ""}
              ${card.rejectionReason ? `<p class="rate-card-rejection">Rejected: ${escapeHtml(card.rejectionReason)}</p>` : ""}
            `}
            <footer class="rate-card-actions">
              ${card.status === "draft" && canPropose ? `
                <button class="rate-card-transition primary" type="button" data-status="submitted">Submit for approval</button>
              ` : ""}
              ${card.status === "submitted" && canApprove ? `
                <button class="rate-card-transition primary" type="button" data-status="approved">Approve</button>
                <button class="rate-card-transition danger" type="button" data-status="rejected">Reject</button>
              ` : ""}
            </footer>
          </article>
        `).join("") || '<div class="list-empty">No rate cards yet.</div>'}
      </div>
    </section>
  `;
}

function workStatusTone(status) {
  if (["quality_approved", "payable_approved", "paid"].includes(status)) return "good";
  if (["offered", "submitted", "included_in_statement"].includes(status)) return "warn";
  if (status === "canceled") return "bad";
  return "neutral";
}

function formatMinorUnits(value, currency, exponent = 2) {
  if (value == null || !currency) return "Not priced";
  const amount = Number(value) / (10 ** Number(exponent ?? 2));
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(amount);
}

function workTransitionButtons(order, party) {
  const buttons = [];
  if (
    party === "customer"
    && order.status === "draft"
    && hasAccessPermission("work_orders.manage")
  ) {
    buttons.push('<button type="button" class="work-transition primary" data-action="offer">Offer</button>');
  }
  if (
    party === "agency"
    && order.status === "offered"
    && hasAccessPermission("work_orders.manage")
  ) {
    buttons.push('<button type="button" class="work-transition primary" data-action="accept">Accept</button>');
  }
  if (
    party === "customer"
    && order.status === "submitted"
    && hasAccessPermission("quality.approve")
  ) {
    buttons.push('<button type="button" class="work-transition primary" data-action="quality_approve">Approve quality</button>');
    buttons.push('<button type="button" class="work-transition" data-action="quality_reject">Request changes</button>');
  }
  if (
    party === "customer"
    && order.status === "quality_approved"
    && hasAccessPermission("payables.approve")
  ) {
    buttons.push('<button type="button" class="work-transition primary" data-action="payable_approve">Approve payable</button>');
  }
  const customerCancelable = party === "customer"
    && ["draft", "offered", "accepted", "in_progress"].includes(order.status);
  const agencyCancelable = party === "agency"
    && ["offered", "accepted"].includes(order.status);
  if (
    (customerCancelable || agencyCancelable)
    && hasAccessPermission("work_orders.manage")
  ) {
    buttons.push('<button type="button" class="work-transition danger" data-action="cancel">Cancel</button>');
  }
  return buttons.join("");
}

function renderWorkOrders(detail, party) {
  if (!hasAccessPermission("work_orders.view")) return "";
  const workOrders = detail.workOrders || [];
  const relationship = detail.vendorRelationship;
  const assignableLinguists = (detail.linguists || []).filter(
    (linguist) => linguist.status === "approved",
  );
  const canCreate = party === "customer"
    && relationship.status === "active"
    && hasAccessPermission("work_orders.manage");
  return `
    <section class="vendor-work">
      <div class="rate-card-heading">
        <div>
          <h3>Work orders</h3>
          <p>Commercial terms are snapshotted when an order is offered.</p>
        </div>
      </div>
      ${canCreate ? `
        <details class="vendor-editor">
          <summary>Create work order</summary>
          <form class="work-order-create-form">
            <label><span>Project</span><select name="projectId" required>
              ${optionList(
                detail.eligibleProjects || [],
                "id",
                (project) => `${project.businessUnitName} · ${project.name}`,
              )}
            </select></label>
            <label><span>Title</span><input name="title" maxlength="200" required></label>
            <label><span>Service</span><input name="serviceType" value="translation" required></label>
            <label><span>Unit</span><select name="unitType">
              ${["source_word", "target_word", "character", "string", "hour", "fixed_job"].map(
                (unit) => `<option value="${unit}">${unit.replaceAll("_", " ")}</option>`,
              ).join("")}
            </select></label>
            <label><span>Source locale</span><input name="sourceLocale" placeholder="en-US"></label>
            <label><span>Target locale</span><input name="targetLocale" placeholder="fr-CA" required></label>
            <label><span>Estimated units</span><input name="estimatedUnits" inputmode="decimal"></label>
            <label><span>Due</span><input name="dueAt" type="datetime-local"></label>
            <label class="work-order-items-input"><span>Source string IDs</span>
              <textarea name="sourceStringIds" placeholder="One UUID per line or comma-separated" required></textarea>
            </label>
            <label class="work-order-items-input"><span>Description</span>
              <textarea name="description" maxlength="5000"></textarea>
            </label>
            <button class="primary" type="submit">Create draft</button>
          </form>
        </details>
      ` : ""}
      <div class="work-order-list">
        ${workOrders.map((order) => {
          const canAssign = ["accepted", "in_progress"].includes(order.status)
            && hasAccessPermission("work_orders.manage")
            && (party === "customer" || relationship.agencyMayAssignLinguists);
          const canAdjust = party === "customer"
            && ["quality_approved", "payable_approved"].includes(order.status)
            && hasAccessPermission("payables.approve");
          const canDispute = ["quality_approved", "payable_approved", "included_in_statement"].includes(
            order.status,
          ) && hasAccessPermission("disputes.open")
            && !(order.disputes || []).some((dispute) => dispute.status === "open");
          return `
            <article class="work-order" data-work-order-id="${escapeHtml(order.id)}">
              <header>
                <div>
                  <strong>#${escapeHtml(order.workOrderNumber)} · ${escapeHtml(order.title)}</strong>
                  <small>${escapeHtml(order.projectName)} · ${escapeHtml(order.sourceLocale || "any")} → ${escapeHtml(order.targetLocale)}</small>
                </div>
                ${badge(order.status, workStatusTone(order.status))}
              </header>
              <div class="work-order-summary">
                <span>${escapeHtml(order.serviceType)} · ${escapeHtml(order.unitType.replaceAll("_", " "))}</span>
                <span>${escapeHtml(order.items.length)} strings</span>
                <span>${escapeHtml(order.deliveryReview?.computedSourceWords ?? 0)} source words</span>
                <span>${formatMinorUnits(
                  order.payableTotalMinor,
                  order.snapshotCurrency,
                  order.snapshotCurrencyExponent,
                )}</span>
                <span>${order.dueAt ? `Due ${escapeHtml(new Date(order.dueAt).toLocaleString())}` : "No due date"}</span>
              </div>
              ${order.snapshotUnitRate != null ? `
                <p class="section-copy">
                  Snapshotted ${escapeHtml(order.snapshotCurrency)} ${escapeHtml(order.snapshotUnitRate)}
                  / ${escapeHtml(order.unitType.replaceAll("_", " "))}
                </p>
              ` : ""}
              ${order.status === "submitted" && order.deliveryReview?.warning ? `
                <p class="rate-card-rejection">
                  Quality review warning: ${escapeHtml(order.deliveryReview.warning.message)}
                  Confirm the submitted quantity before approving quality and creating the payable entry.
                </p>
              ` : ""}
              <div class="work-order-actions">${workTransitionButtons(order, party)}</div>
              <details class="vendor-editor">
                <summary>Delivery, assignments, and ledger</summary>
                <div class="management-list">
                  ${(order.assignments || []).map((assignment) => `
                    <div class="work-assignment-row">
                      <div>
                        <strong>${escapeHtml(assignment.displayName || assignment.email)}</strong>
                        <small>${escapeHtml(assignment.assignmentRole)} · ${escapeHtml(assignment.status)}</small>
                      </div>
                      ${assignment.status === "active" && canAssign ? `
                        <button type="button" class="work-assignment-revoke danger"
                                data-assignment-id="${escapeHtml(assignment.id)}">Revoke</button>
                      ` : ""}
                    </div>
                  `).join("") || '<div class="list-empty">No linguists assigned.</div>'}
                </div>
                ${canAssign && assignableLinguists.length ? `
                  <form class="work-assignment-form inline-form">
                    <select name="agencyMembershipId">
                      ${optionList(
                        assignableLinguists,
                        "agencyMembershipId",
                        (linguist) => linguist.displayName || linguist.email,
                      )}
                    </select>
                    <select name="assignmentRole">
                      <option value="translator">Translator</option>
                      <option value="reviewer">Reviewer</option>
                      <option value="lead">Lead</option>
                    </select>
                    <button type="submit">Assign</button>
                  </form>
                ` : ""}
                ${(order.submissions || []).map((submission) => `
                  <div class="work-delivery-row">
                    <span>Delivery ${escapeHtml(submission.deliveredUnits)} ${escapeHtml(order.unitType.replaceAll("_", " "))}</span>
                    ${badge(submission.qualityStatus, workStatusTone(
                      submission.qualityStatus === "approved" ? "quality_approved" : submission.qualityStatus,
                    ))}
                    ${submission.qualityReason ? `<small>${escapeHtml(submission.qualityReason)}</small>` : ""}
                  </div>
                `).join("")}
                ${(order.ledger || []).length ? `
                  <div class="work-ledger">
                    ${(order.ledger || []).map((entry) => `
                      <div>
                        <span>${escapeHtml(entry.entryType.replaceAll("_", " "))}</span>
                        <strong>${formatMinorUnits(
                          entry.amountMinor,
                          entry.currency,
                          order.snapshotCurrencyExponent,
                        )}</strong>
                      </div>
                    `).join("")}
                  </div>
                ` : ""}
                ${canAdjust ? `
                  <form class="work-adjustment-form inline-form">
                    <input name="amountMinor" type="number" step="1" placeholder="Amount in minor units" required>
                    <input name="reason" maxlength="2000" placeholder="Adjustment reason" required>
                    <button type="submit">Add adjustment</button>
                  </form>
                ` : ""}
                ${(order.disputes || []).map((dispute) => `
                  <div class="work-dispute-row">
                    <div>
                      <strong>${escapeHtml(dispute.openedByParty)} dispute</strong>
                      <small>${escapeHtml(dispute.reason)}</small>
                    </div>
                    ${badge(dispute.status, dispute.status === "open" ? "warn" : "neutral")}
                    ${party === "customer" && dispute.status === "open" && hasAccessPermission("payables.approve") ? `
                      <button type="button" class="work-dispute-resolve"
                              data-dispute-id="${escapeHtml(dispute.id)}">Resolve</button>
                    ` : ""}
                  </div>
                `).join("")}
                ${canDispute ? `
                  <form class="work-dispute-form inline-form">
                    <input name="reason" maxlength="2000" placeholder="Dispute reason" required>
                    <button type="submit">Open dispute</button>
                  </form>
                ` : ""}
              </details>
            </article>
          `;
        }).join("") || '<div class="list-empty">No work orders yet.</div>'}
      </div>
    </section>
  `;
}

function renderPayableStatements(detail, party) {
  if (!hasAccessPermission("payables.view")) return "";
  const statements = detail.statements || [];
  const payableOrders = (detail.workOrders || []).filter(
    (order) => order.status === "payable_approved",
  );
  return `
    <section class="vendor-payables">
      <div class="rate-card-heading">
        <div>
          <h3>Payable statements</h3>
          <p>Record external settlement or use the separately gated Stripe vendor-payment rail. SaaS subscriptions are separate.</p>
        </div>
      </div>
      ${party === "customer" && hasAccessPermission("payables.approve") && payableOrders.length ? `
        <details class="vendor-editor">
          <summary>Create statement</summary>
          <form class="statement-create-form">
            <label><span>Work orders</span><select name="workOrderIds" multiple required>
              ${optionList(
                payableOrders,
                "id",
                (order) => `#${order.workOrderNumber} · ${order.title}`,
              )}
            </select></label>
            <label><span>Period start</span><input name="periodStart" type="date" value="${currentDateInputValue()}" required></label>
            <label><span>Period end</span><input name="periodEnd" type="date" value="${currentDateInputValue()}" required></label>
            <label><span>Notes</span><input name="notes" maxlength="5000"></label>
            <button class="primary" type="submit">Create draft statement</button>
          </form>
        </details>
      ` : ""}
      <div class="statement-list">
        ${statements.map((statement) => {
          const facilitated = statement.facilitatedPayment || null;
          const facilitatedPayment = facilitated?.payment || null;
          const activeAttempt = facilitated?.attempts?.[0] || null;
          return `
          <article class="payable-statement" data-statement-id="${escapeHtml(statement.id)}">
            <header>
              <div>
                <strong>Statement #${escapeHtml(statement.statementNumber)}</strong>
                <small>${escapeHtml(statement.periodStart)} – ${escapeHtml(statement.periodEnd)}</small>
              </div>
              ${badge(statement.status, workStatusTone(statement.status))}
            </header>
            <div class="work-order-summary">
              <span>${formatMinorUnits(statement.subtotalMinor, statement.currency)}</span>
              <span>${escapeHtml(statement.items.length)} work orders</span>
              <span>${statement.dueDate ? `Due ${escapeHtml(statement.dueDate)}` : "Not finalized"}</span>
              <span>Paid ${formatMinorUnits(statement.confirmedPaymentMinor, statement.currency)}</span>
            </div>
            <div class="work-order-actions">
              ${party === "customer" && statement.status === "draft" && hasAccessPermission("payables.approve") ? `
                <button type="button" class="statement-transition primary" data-action="finalize">Finalize</button>
              ` : ""}
              ${party === "customer" && ["draft", "finalized"].includes(statement.status) && hasAccessPermission("payables.approve") ? `
                <button type="button" class="statement-transition danger" data-action="void">Void</button>
              ` : ""}
              ${party === "customer"
                && statement.status === "finalized"
                && facilitated?.eligibility?.eligible
                && hasAccessPermission("facilitated_payments.initiate") ? `
                <button type="button" class="statement-pay primary">Pay securely with Stripe</button>
              ` : ""}
              ${party === "customer"
                && activeAttempt?.checkoutUrl
                && ["created", "requires_action", "processing"].includes(activeAttempt.state)
                && activeAttempt.checkoutStatus === "open" ? `
                <button type="button" class="statement-checkout-resume primary"
                        data-checkout-url="${escapeHtml(activeAttempt.checkoutUrl)}">Continue secure Checkout</button>
              ` : ""}
            </div>
            ${facilitated ? `
              <div class="payment-row facilitated-payment-row">
                <div>
                  <strong>Facilitated payment</strong>
                  <small>${facilitatedPayment
                    ? `${escapeHtml(facilitatedPayment.fundingState)} · transfer ${escapeHtml(facilitatedPayment.transferState || "not created")}`
                    : activeAttempt
                      ? `${escapeHtml(activeAttempt.state)} · Checkout ${escapeHtml(activeAttempt.checkoutStatus)}`
                      : facilitated.eligibility?.eligible
                        ? "Eligible for secure Checkout"
                        : `Unavailable: ${escapeHtml((facilitated.eligibility?.reasons || []).join(", ") || "not eligible")}`
                  }</small>
                </div>
                ${facilitatedPayment
                  ? badge(
                    facilitatedPayment.fundingState,
                    facilitatedPayment.fundingState === "funded" ? "good" : "warn",
                  )
                  : activeAttempt
                    ? badge(activeAttempt.state, paymentStatusTone(activeAttempt.state))
                    : ""}
              </div>
              ${party === "customer"
                && facilitatedPayment
                && hasAccessPermission("facilitated_payments.refund") ? `
                <details class="vendor-editor">
                  <summary>Request refund</summary>
                  <form class="facilitated-refund-form inline-form">
                    <input name="amountMinor" type="number" min="1"
                           max="${escapeHtml(facilitatedPayment.amountMinor)}"
                           placeholder="Amount in minor units" required>
                    <input name="reason" maxlength="2000" placeholder="Refund reason" required>
                    <input name="reference" maxlength="500" placeholder="Ticket or credit reference" required>
                    <button type="submit">Submit for platform approval</button>
                  </form>
                </details>
              ` : ""}
            ` : ""}
            ${(statement.payments || []).map((payment) => `
              <div class="payment-row" data-payment-id="${escapeHtml(payment.id)}">
                <div>
                  <strong>${formatMinorUnits(payment.amountMinor, payment.currency)}</strong>
                  <small>${escapeHtml(payment.paymentMethod)} · ${escapeHtml(payment.externalReference)}</small>
                </div>
                ${badge(payment.status, payment.status === "confirmed" ? "good" : payment.status === "reported" ? "warn" : "bad")}
                ${party === "customer" && payment.status === "reported" && hasAccessPermission("payment_records.manage") ? `
                  <div class="row-actions">
                    <button type="button" class="payment-decision primary" data-status="confirmed">Confirm</button>
                    <button type="button" class="payment-decision" data-status="rejected">Reject</button>
                  </div>
                ` : ""}
              </div>
            `).join("")}
            ${statement.status === "finalized"
              && !activeAttempt
              && hasAccessPermission("payment_records.manage") ? `
              <form class="payment-record-form">
                <input name="amountMinor" type="number" min="1" step="1" placeholder="Amount in minor units" required>
                <input name="paymentMethod" placeholder="ACH, wire, check…" required>
                <input name="externalReference" placeholder="External reference" required>
                <input name="paidAt" type="datetime-local" required>
                <button type="submit">${party === "customer" ? "Record payment" : "Report payment"}</button>
              </form>
            ` : ""}
          </article>
        `;
        }).join("") || '<div class="list-empty">No payable statements yet.</div>'}
      </div>
    </section>
  `;
}

function renderVendorRelationships() {
  if (!hasAccessPermission("vendors.view")) return;
  $("vendorRelationshipList").innerHTML = vendorRelationshipState.map((detail) => {
    const relationship = detail.vendorRelationship;
    const party = relationship.customerOrganizationId === accessState.organization.id
      ? "customer"
      : "agency";
    const counterparty = party === "customer" ? relationship.agencyName : relationship.customerName;
    const structuralScopes = detail.scopes.filter((scope) => scope.scopeId);
    const localeScopes = detail.scopes.filter((scope) => scope.scopeType === "locale");
    const serviceScopes = detail.scopes.filter((scope) => scope.scopeType === "service_type");
    const classificationScopes = detail.scopes.filter(
      (scope) => scope.scopeType === "content_classification",
    );
    const canManage = hasAccessPermission("vendors.manage");
    const canApprove = hasAccessPermission("vendor_linguists.approve");
    return `
      <article class="vendor-relationship" data-id="${escapeHtml(relationship.id)}">
        <header class="vendor-relationship-header">
          <div>
            <strong>${escapeHtml(counterparty)}</strong>
            <small>${escapeHtml(party === "customer" ? "Agency" : "Customer")} · ${escapeHtml(relationship.id)}</small>
          </div>
          <div class="vendor-status">
            ${badge(relationship.status, vendorStatusTone(relationship.status))}
            <span>${escapeHtml(relationship.defaultCurrency)} · Net ${escapeHtml(relationship.paymentTermsDays ?? 30)}</span>
          </div>
        </header>

        <div class="vendor-summary">
          <span><strong>${structuralScopes.length}</strong> structural scopes</span>
          <span><strong>${detail.linguists.filter((item) => item.status === "approved").length}</strong> approved linguists</span>
          <span>${relationship.requiresLinguistApproval ? "Customer approval required" : "Policy auto-approval"}</span>
          <span>${relationship.agencyMayAssignLinguists ? "Agency assignment enabled" : "Customer assignment only"}</span>
        </div>

        ${party === "customer" && canManage && relationship.status !== "terminated" ? `
          <details class="vendor-editor">
            <summary>Relationship settings</summary>
            <form class="vendor-settings-form">
              <label><span>Currency</span><input name="defaultCurrency" maxlength="3" value="${escapeHtml(relationship.defaultCurrency)}" required></label>
              <label><span>Payment terms</span><input name="paymentTermsDays" type="number" min="0" step="1" value="${escapeHtml(relationship.paymentTermsDays ?? 30)}" required></label>
              <label><span>Customer vendor #</span><input name="customerVendorNumber" value="${escapeHtml(relationship.customerVendorNumber || "")}"></label>
              <label><span>Effective from</span><input name="effectiveFrom" type="date" value="${escapeHtml(dateInputValue(relationship.effectiveFrom))}"></label>
              <label><span>Effective to</span><input name="effectiveTo" type="date" value="${escapeHtml(dateInputValue(relationship.effectiveTo))}"></label>
              <label><span>Subcontracting depth</span><input name="maximumSubcontractingDepth" type="number" min="0" step="1" value="${escapeHtml(relationship.maximumSubcontractingDepth)}" required></label>
              <label class="check-field"><input name="requiresLinguistApproval" type="checkbox" ${relationship.requiresLinguistApproval ? "checked" : ""}><span>Require linguist approval</span></label>
              <label class="check-field"><input name="agencyMayAssignLinguists" type="checkbox" ${relationship.agencyMayAssignLinguists ? "checked" : ""}><span>Agency may assign linguists</span></label>
              <button class="primary" type="submit">Save settings</button>
            </form>
          </details>

          <details class="vendor-editor">
            <summary>Eligible scope</summary>
            <form class="vendor-scopes-form">
              <label class="vendor-structural-scope">
                <span>Business units and projects</span>
                <select name="structuralScopes" multiple>${vendorScopeOptions(detail)}</select>
              </label>
              <label><span>Locales</span><input name="locales" value="${escapeHtml(commaSeparated(localeScopes))}" placeholder="fr-CA, de-DE"></label>
              <label><span>Service types</span><input name="serviceTypes" value="${escapeHtml(commaSeparated(serviceScopes))}" placeholder="translation, review"></label>
              <label><span>Content classifications</span><input name="contentClassifications" value="${escapeHtml(commaSeparated(classificationScopes))}" placeholder="public, confidential"></label>
              <button class="primary" type="submit">Save scope</button>
            </form>
            <p class="section-copy">At least one business unit or project is required before activation.</p>
          </details>
        ` : `
          <div class="vendor-scope-readonly">
            <strong>Eligible scope</strong>
            <span>${structuralScopes.map((scope) => escapeHtml(scope.scopeName || scope.scopeId)).join(", ") || "No structural scope yet"}</span>
            ${localeScopes.length ? `<small>Locales: ${escapeHtml(commaSeparated(localeScopes))}</small>` : ""}
          </div>
        `}

        <section class="vendor-linguists">
          <h3>Linguists</h3>
          ${party === "agency" && canManage && ["onboarding", "active"].includes(relationship.status) ? `
            <form class="vendor-nominate-form">
              <select name="agencyMembershipId" required>
                ${optionList(
                  accessState.members.filter((member) => member.status === "active"),
                  "id",
                  (member) => member.displayName || member.email,
                )}
              </select>
              <input name="locales" placeholder="Locales (optional)">
              <button type="submit">Nominate linguist</button>
            </form>
          ` : ""}
          <div class="management-list">
            ${detail.linguists.map((linguist) => `
              <div class="vendor-linguist-row" data-linguist-id="${escapeHtml(linguist.id)}">
                <div>
                  <strong>${escapeHtml(linguist.displayName || linguist.email)}</strong>
                  <small>${escapeHtml(linguist.email)}${linguist.conditions?.locales?.length ? ` · ${escapeHtml(linguist.conditions.locales.join(", "))}` : ""}</small>
                </div>
                ${badge(linguist.status, linguist.status === "approved" ? "good" : linguist.status === "pending" ? "warn" : "neutral")}
                <div class="row-actions">
                  ${party === "customer" && canApprove && linguist.status === "pending" ? `
                    <button type="button" class="vendor-linguist-action primary" data-status="approved">Approve</button>
                    <button type="button" class="vendor-linguist-action" data-status="rejected">Reject</button>
                  ` : ""}
                  ${party === "customer" && canApprove && linguist.status === "approved" ? `
                    <button type="button" class="vendor-linguist-action danger" data-status="revoked">Revoke</button>
                  ` : ""}
                </div>
              </div>
            `).join("") || '<div class="list-empty">No linguists nominated.</div>'}
          </div>
          ${detail.linguists.length && detail.eligibleProjects?.length ? `
            <details class="vendor-editor">
              <summary>Check assignment readiness</summary>
              <form class="vendor-eligibility-form">
                <label>
                  <span>Linguist</span>
                  <select name="agencyMembershipId">
                    ${optionList(
                      detail.linguists,
                      "agencyMembershipId",
                      (linguist) => linguist.displayName || linguist.email,
                    )}
                  </select>
                </label>
                <label>
                  <span>Project</span>
                  <select name="projectId">
                    ${optionList(
                      detail.eligibleProjects,
                      "id",
                      (project) => `${project.businessUnitName} · ${project.name}`,
                    )}
                  </select>
                </label>
                <label><span>Locale</span><input name="locale" value="${escapeHtml(localeScopes[0]?.scopeValue || "")}" placeholder="fr-CA"></label>
                <label><span>Service type</span><input name="serviceType" placeholder="translation"></label>
                <label><span>Content classification</span><input name="contentClassification" placeholder="public"></label>
                <button type="submit">Check readiness</button>
              </form>
              <div class="vendor-eligibility-result" hidden></div>
            </details>
          ` : ""}
        </section>

        ${renderRateCards(detail, party)}
        ${renderWorkOrders(detail, party)}
        ${renderPayableStatements(detail, party)}

        ${canManage ? `
          <footer class="vendor-actions">
            ${vendorTransitionButtons(relationship, party)}
          </footer>
        ` : ""}
      </article>
    `;
  }).join("") || '<div class="list-empty">No agency relationships.</div>';
  applyPermissionVisibility();
}

async function loadVendorRelationships() {
  if (!hasAccessPermission("vendors.view")) {
    vendorRelationshipState = [];
    return;
  }
  const list = await api(accessPath("/vendor-relationships"));
  vendorRelationshipState = await Promise.all(
    (list.vendorRelationships || []).map(async (relationship) => {
      let detail = await api(
        accessPath(`/vendor-relationships/${encodeURIComponent(relationship.id)}`),
      );
      const relationshipPath = `/vendor-relationships/${encodeURIComponent(relationship.id)}`;
      const loaders = [];
      if (hasAccessPermission("rate_cards.view")) {
        loaders.push(api(accessPath(`${relationshipPath}/rate-cards`)).then((data) => {
          detail = { ...detail, rateCards: data.rateCards || [] };
        }));
      }
      if (hasAccessPermission("work_orders.view")) {
        loaders.push(api(accessPath(`${relationshipPath}/work-orders`)).then((data) => {
          detail = { ...detail, workOrders: data.workOrders || [] };
        }));
      }
      if (hasAccessPermission("payables.view")) {
        loaders.push(api(accessPath(`${relationshipPath}/payable-statements`)).then((data) => {
          detail = { ...detail, statements: data.statements || [] };
        }));
      }
      await Promise.all(loaders);
      if (
        hasAccessPermission("facilitated_payments.view")
        && Array.isArray(detail.statements)
      ) {
        detail.statements = await Promise.all(detail.statements.map(async (statement) => {
          const facilitatedPayment = await api(accessPath(
            `${relationshipPath}/payable-statements/${encodeURIComponent(statement.id)}/facilitated-payment`,
          ));
          return { ...statement, facilitatedPayment };
        }));
      }
      return detail;
    }),
  );
  renderVendorRelationships();
}

function renderAccess() {
  if (!accessState) return;
  accessPermissionSet = new Set(accessState.permissions || []);
  applyPermissionVisibility();
  $("businessUnitList").innerHTML = accessState.businessUnits.map((unit) => `
    <form class="management-row business-unit-row" data-id="${escapeHtml(unit.id)}">
      <div><strong>${escapeHtml(unit.name)}</strong><small>${escapeHtml(unit.slug)}</small></div>
      <input name="name" value="${escapeHtml(unit.name)}" ${hasAccessPermission("business_units.manage") ? "" : "disabled"}>
      <select name="status" ${hasAccessPermission("business_units.manage") ? "" : "disabled"}>
        <option value="active" ${unit.status === "active" ? "selected" : ""}>Active</option>
        <option value="archived" ${unit.status === "archived" ? "selected" : ""}>Archived</option>
      </select>
      ${hasAccessPermission("business_units.manage") ? '<button type="submit">Save</button>' : ""}
    </form>
  `).join("") || '<div class="list-empty">No business units.</div>';

  $("memberList").innerHTML = accessState.members.map((member) => `
    <form class="management-row member-row" data-id="${escapeHtml(member.id)}">
      <div><strong>${escapeHtml(member.displayName || member.email)}</strong><small>${escapeHtml(member.email)}</small></div>
      <select name="membershipType" ${hasAccessPermission("members.manage") ? "" : "disabled"}>
        <option value="internal" ${member.membershipType === "internal" ? "selected" : ""}>Internal</option>
        <option value="external" ${member.membershipType === "external" ? "selected" : ""}>External</option>
      </select>
      <select name="status" ${hasAccessPermission("members.manage") ? "" : "disabled"}>
        ${["invited", "active", "suspended", "removed"].map((status) => `<option value="${status}" ${member.status === status ? "selected" : ""}>${status}</option>`).join("")}
      </select>
      <input name="expiresAt" type="datetime-local" aria-label="Access expires" value="${escapeHtml(dateTimeInputValue(member.expiresAt))}" ${hasAccessPermission("members.manage") ? "" : "disabled"}>
      ${hasAccessPermission("members.manage") ? '<button type="submit">Save</button>' : ""}
    </form>
  `).join("") || '<div class="list-empty">No members.</div>';

  $("teamList").innerHTML = accessState.teams.map((team) => `
    <form class="management-row team-row" data-id="${escapeHtml(team.id)}">
      <div><strong>${escapeHtml(team.name)}</strong><small>${team.membershipIds.length} members</small></div>
      <select name="membershipIds" multiple ${hasAccessPermission("teams.manage") ? "" : "disabled"}>
        ${accessState.members.filter((member) => member.status !== "removed").map((member) => `
          <option value="${escapeHtml(member.id)}" ${team.membershipIds.includes(member.id) ? "selected" : ""}>
            ${escapeHtml(member.displayName || member.email)}
          </option>`).join("")}
      </select>
      ${hasAccessPermission("teams.manage") ? '<button type="submit">Save members</button>' : ""}
    </form>
  `).join("") || '<div class="list-empty">No teams.</div>';

  $("assignmentRole").innerHTML = optionList(accessState.roles, "id", (role) => role.name);
  updateAssignmentPrincipals();
  updateAssignmentScopes();
  $("assignmentList").innerHTML = accessState.assignments.map((assignment) => `
    <div class="management-row">
      <div><strong>${escapeHtml(accessName(assignment.principalType, assignment.principalId))}</strong><small>${escapeHtml(assignment.principalType)}</small></div>
      <span>${escapeHtml(assignment.roleName)}</span>
      <span>${escapeHtml(scopeName(assignment.scopeType, assignment.scopeId))}${assignment.inheritToChildren ? " + children" : ""}${assignment.conditions?.locales?.length ? ` · ${escapeHtml(assignment.conditions.locales.join(", "))}` : ""}</span>
      ${hasAccessPermission("roles.assign") ? `<button class="assignment-revoke danger" data-id="${escapeHtml(assignment.id)}">Revoke</button>` : ""}
    </div>
  `).join("") || '<div class="list-empty">No active role assignments.</div>';
}

function renderEnterpriseAccess() {
  if (identityState) {
    $("identitySsoRequired").checked = identityState.policy.ssoRequired;
    $("identityJitEnabled").checked = identityState.policy.jitMembershipEnabled;
    $("identityJitType").value = identityState.policy.jitMembershipType;
    $("identityDomainList").innerHTML = identityState.domains.map((item) => `
      <div class="management-row">
        <div><strong>${escapeHtml(item.domain)}</strong><small>${escapeHtml(item.status)}</small></div>
        <span>${item.verifiedAt ? escapeHtml(new Date(item.verifiedAt).toLocaleString()) : "DNS verification pending"}</span>
        ${item.status === "pending" ? `<button class="identity-domain-verify" data-id="${escapeHtml(item.id)}" type="button">Verify DNS</button>` : ""}
      </div>
    `).join("") || '<div class="list-empty">No organization domains claimed.</div>';
    $("identityConnectionList").innerHTML = identityState.connections.map((item) => `
      <div class="management-row">
        <div><strong>${escapeHtml(item.displayName)}</strong><small>${escapeHtml(item.connectionType.toUpperCase())} · ${escapeHtml(item.cognitoProviderName)}</small></div>
        ${badge(item.status, item.status === "active" ? "good" : "neutral")}
        <button class="identity-connection-toggle" data-id="${escapeHtml(item.id)}" data-status="${item.status === "active" ? "disabled" : "active"}" type="button">
          ${item.status === "active" ? "Disable" : "Activate"}
        </button>
      </div>
    `).join("") || '<div class="list-empty">No Cognito identity connections.</div>';
    $("identityRecoveryUser").innerHTML = optionList(
      (accessState?.members || []).filter((member) => member.status === "active"),
      "userId",
      (member) => member.displayName || member.email,
    );
    $("identityRecoveryList").innerHTML = identityState.recoveryGrants.map((grant) => `
      <div class="management-row">
        <div><strong>${escapeHtml(grant.email)}</strong><small>${escapeHtml(grant.reason)}</small></div>
        <span>Expires ${escapeHtml(new Date(grant.expiresAt).toLocaleString())}</span>
        <button class="identity-recovery-revoke danger" data-id="${escapeHtml(grant.id)}" type="button">Revoke</button>
      </div>
    `).join("") || '<div class="list-empty">No active recovery login grants.</div>';
  }

  $("serviceAccountList").innerHTML = serviceAccountState.map((account) => `
    <div class="management-row">
      <div><strong>${escapeHtml(account.name)}</strong><small>${account.credentials?.length || 0} credentials · ${escapeHtml(account.status)}</small></div>
      <span>${account.credentials?.[0]?.lastUsedAt ? `Last used ${escapeHtml(new Date(account.credentials[0].lastUsedAt).toLocaleString())}` : "Never used"}</span>
      ${account.status !== "revoked" ? `<button class="service-account-rotate" data-id="${escapeHtml(account.id)}" type="button">Rotate</button>` : ""}
    </div>
  `).join("") || '<div class="list-empty">No service accounts.</div>';

  $("scimTokenList").innerHTML = scimTokenState.map((token) => `
    <div class="management-row">
      <div><strong>${escapeHtml(token.name)}</strong><small>Prefix ${escapeHtml(token.prefix)}</small></div>
      <span>${token.lastUsedAt ? `Last used ${escapeHtml(new Date(token.lastUsedAt).toLocaleString())}` : escapeHtml(token.status)}</span>
      ${token.status === "active" ? `<button class="scim-token-revoke danger" data-id="${escapeHtml(token.id)}" type="button">Revoke</button>` : ""}
    </div>
  `).join("") || '<div class="list-empty">No SCIM tokens.</div>';

  $("accessReviewReviewer").innerHTML = optionList(
    (accessState?.members || []).filter((member) => member.status === "active"),
    "userId",
    (member) => member.displayName || member.email,
  );
  $("accessRequestList").innerHTML = accessRequestState.filter((item) => item.status === "pending").map((item) => `
    <div class="management-row">
      <div><strong>${escapeHtml(item.requesterEmail)}</strong><small>${escapeHtml(item.reason)}</small></div>
      <span>${escapeHtml(item.roleName)} · ${escapeHtml(scopeName(item.scopeType, item.scopeId))}</span>
      <span>
        <button class="access-request-decision" data-id="${escapeHtml(item.id)}" data-decision="approved" type="button">Approve</button>
        <button class="access-request-decision danger" data-id="${escapeHtml(item.id)}" data-decision="rejected" type="button">Reject</button>
      </span>
    </div>
  `).join("") || '<div class="list-empty">No pending access requests.</div>';
  $("accessReviewList").innerHTML = accessReviewState.map((campaign) => `
    <div class="management-row">
      <div><strong>${escapeHtml(campaign.name)}</strong><small>${campaign.itemCount} grants · ${campaign.pendingCount} pending</small></div>
      ${badge(campaign.status, campaign.status === "completed" ? "good" : campaign.status === "open" ? "warn" : "neutral")}
      <span>
        ${campaign.status === "draft" ? `<button class="access-review-transition" data-id="${escapeHtml(campaign.id)}" data-transition="open" type="button">Open</button>` : ""}
        ${campaign.status === "open" ? `<button class="access-review-load" data-id="${escapeHtml(campaign.id)}" type="button">Review</button><button class="access-review-transition" data-id="${escapeHtml(campaign.id)}" data-transition="complete" type="button">Complete</button>` : ""}
      </span>
    </div>
  `).join("") || '<div class="list-empty">No access certification campaigns.</div>';

  if (governanceReportState) {
    const staleMembers = governanceReportState.members.filter((member) => member.stale);
    const expiring = governanceReportState.assignments.filter((item) => item.expiresSoon);
    const withoutCredentials = governanceReportState.serviceAccounts.filter((item) => item.activeCredentialCount === 0);
    $("governanceReport").innerHTML = `
      <div class="management-row"><strong>${staleMembers.length}</strong><span>members inactive for ${escapeHtml(governanceReportState.staleDays)}+ days</span></div>
      <div class="management-row"><strong>${expiring.length}</strong><span>role grants expire within 30 days</span></div>
      <div class="management-row"><strong>${withoutCredentials.length}</strong><span>service accounts without active credentials</span></div>
    `;
  }
}

function paymentStatusTone(status) {
  if (["approved", "ready", "active"].includes(status)) return "good";
  if (["pending", "restricted", "suspended"].includes(status)) return "warn";
  if (["disabled", "terminated"].includes(status)) return "bad";
  return "neutral";
}

function paymentSummaryItem(label, value, tone = "neutral") {
  return `
    <div class="payment-readiness-item">
      <small>${escapeHtml(label)}</small>
      <strong class="${escapeHtml(tone)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderFacilitatedPayments() {
  const state = payoutAccountState || paymentProgramState;
  const card = $("facilitatedPaymentsCard");
  if (!state) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const enrollment = state.enrollment;
  const account = payoutAccountState?.connectedAccount || null;
  const configuration = state.configuration || {};
  const featureEnabled = state.feature?.enabled === true;
  $("facilitatedPaymentBadges").innerHTML = [
    badge(configuration.providerMode || "not configured"),
    badge(featureEnabled ? "rollout enabled" : "rollout disabled", featureEnabled ? "good" : "neutral"),
    badge(enrollment?.status || "not enrolled", paymentStatusTone(enrollment?.status)),
    ...(account ? [badge(account.onboardingState, paymentStatusTone(account.onboardingState))] : []),
  ].join("");
  $("facilitatedPaymentSummary").innerHTML = [
    paymentSummaryItem(
      "Server switch",
      configuration.enabled ? "Enabled" : "Disabled",
      configuration.enabled ? "good" : "neutral",
    ),
    paymentSummaryItem(
      "Organization rollout",
      featureEnabled ? "Enabled" : "Disabled",
      featureEnabled ? "good" : "neutral",
    ),
    paymentSummaryItem(
      "Program",
      enrollment?.status || "Not enrolled",
      paymentStatusTone(enrollment?.status),
    ),
    paymentSummaryItem(
      "Money movement",
      [
        configuration.collectionEnabled ? "collect" : null,
        configuration.transfersEnabled ? "transfer" : null,
        configuration.refundsEnabled ? "refund" : null,
      ].filter(Boolean).join(" · ") || "Disabled",
      configuration.collectionEnabled || configuration.transfersEnabled
        ? "warn"
        : "neutral",
    ),
  ].join("");

  const programForm = $("paymentProgramForm");
  const supportedOrganization = ["customer", "agency"].includes(
    state.organization?.organizationType,
  );
  programForm.hidden = !isPlatformHuman() || !supportedOrganization;
  if (isPlatformHuman() && supportedOrganization) {
    programForm.elements.status.value = enrollment?.status === "terminated"
      ? "terminated"
      : enrollment?.status || "approved";
    programForm.elements.perPaymentCap.value = minorUnitsToUsd(
      enrollment?.perPaymentCapMinor || "1000000",
    );
    programForm.elements.rollingCap.value = minorUnitsToUsd(
      enrollment?.rollingCapMinor || "2500000",
    );
    programForm.elements.rollingPeriodDays.value = enrollment?.rollingPeriodDays || 30;
    programForm.elements.termsVersion.value = enrollment?.termsVersion || "connect-us-v1";
    programForm.elements.policyVersion.value = enrollment?.policyVersion || "payments-us-v1";
    programForm.elements.acceptanceReference.value = enrollment?.acceptanceEvidence?.reference || "";
    programForm.elements.featureEnabled.checked = featureEnabled;
    programForm.elements.status.disabled = enrollment?.status === "terminated";
    programForm.querySelector('button[type="submit"]').disabled = enrollment?.status === "terminated";
  }

  const operationsPanel = $("platformPaymentOperations");
  operationsPanel.hidden = !isPlatformHuman() || !paymentOperationsState;
  if (isPlatformHuman() && paymentOperationsState) {
    const counts = paymentOperationsState.counts || {};
    const certification = paymentOperationsState.certification || {};
    $("platformPaymentOperationCounts").innerHTML = [
      paymentSummaryItem("Active payments", counts.activeAttempts ?? 0),
      paymentSummaryItem("Transfer queue", counts.transferQueue ?? 0),
      paymentSummaryItem("Refund queue", counts.refundQueue ?? 0),
      paymentSummaryItem("Payouts in flight", counts.nonterminalPayouts ?? 0),
      paymentSummaryItem(
        "Open exceptions",
        counts.openExceptions ?? 0,
        counts.openExceptions ? "bad" : "good",
      ),
      paymentSummaryItem("Recovery cases", counts.openRecoveryCases ?? 0),
      paymentSummaryItem(
        "Certification",
        certification.ready ? "Passed" : `${certification.missing?.length || 0} remaining`,
        certification.ready ? "good" : "warn",
      ),
    ].join("");
  }

  const isAgency = state.organization?.organizationType === "agency";
  $("payoutAccountPanel").hidden = !isAgency || !payoutAccountState;
  if (!isAgency || !payoutAccountState) return;

  const canManage = payoutAccountState.canManage === true;
  const enrollmentApproved = enrollment?.status === "approved";
  const canOnboard = canManage
    && configuration.enabled
    && featureEnabled
    && enrollmentApproved
    && account?.onboardingState !== "disabled";
  $("payoutAccountMessage").textContent = account
    ? `Stripe account ${account.providerAccountId || "is being created"} is ${account.onboardingState}.`
    : enrollmentApproved && featureEnabled
      ? "No Stripe payout account has been created."
      : "Platform approval and organization rollout are required before onboarding.";
  const requirements = [
    ...(account?.requirementsDue || []).map((value) => ({ label: value, kind: "Due now" })),
    ...(account?.requirementsPendingVerification || []).map((value) => ({
      label: value,
      kind: "Pending verification",
    })),
    ...(account?.futureRequirementsDue || []).map((value) => ({
      label: value,
      kind: "Future requirement",
    })),
  ];
  $("payoutAccountRequirements").innerHTML = requirements.map((requirement) => `
    <div class="management-row">
      <strong>${escapeHtml(requirement.label)}</strong>
      <span>${escapeHtml(requirement.kind)}</span>
    </div>
  `).join("") || '<div class="list-empty">No outstanding provider requirements reported.</div>';
  $("payoutAccountActions").hidden = !canManage;
  $("payoutOnboarding").hidden = !canOnboard;
  $("payoutOnboarding").textContent = account?.providerAccountId
    ? "Continue Stripe onboarding"
    : "Start Stripe onboarding";
  $("payoutRefresh").hidden = !canManage || !account?.providerAccountId;
  $("payoutDashboard").hidden = !canManage || !account?.providerAccountId;

}

async function loadFacilitatedPayments() {
  paymentProgramState = null;
  payoutAccountState = null;
  paymentOperationsState = null;
  const organizationId = $("accessOrganization").value;
  const loaders = [];
  if (isPlatformAdminClient()) {
    loaders.push(
      api(`/api/platform/facilitated-payments/organizations/${encodeURIComponent(organizationId)}/program`)
        .then((data) => { paymentProgramState = data; }),
    );
    loaders.push(
      api("/api/platform/facilitated-payments/operations")
        .then((data) => { paymentOperationsState = data; }),
    );
  }
  if (
    accessState?.organization?.organizationType === "agency"
    && hasAccessPermission("payout_accounts.view")
  ) {
    loaders.push(
      api(accessPath("/payout-account")).then((data) => { payoutAccountState = data; }),
    );
  }
  await Promise.all(loaders);
  renderFacilitatedPayments();
}

async function savePaymentProgram(event) {
  event.preventDefault();
  const form = event.target;
  const organizationId = $("accessOrganization").value;
  const status = form.elements.status.value;
  if (
    status === "terminated"
    && !window.confirm("Terminate this enrollment permanently? It cannot be reopened.")
  ) return;
  paymentProgramState = await api(
    `/api/platform/facilitated-payments/organizations/${encodeURIComponent(organizationId)}/program`,
    {
      method: "PUT",
      body: JSON.stringify({
        status,
        perPaymentCapMinor: usdToMinorUnits(form.elements.perPaymentCap.value),
        rollingCapMinor: usdToMinorUnits(form.elements.rollingCap.value),
        rollingPeriodDays: Number(form.elements.rollingPeriodDays.value),
        termsVersion: form.elements.termsVersion.value,
        policyVersion: form.elements.policyVersion.value,
        acceptanceReference: form.elements.acceptanceReference.value,
        featureEnabled: form.elements.featureEnabled.checked,
        reason: form.elements.reason.value,
      }),
    },
  );
  form.elements.reason.value = "";
  await Promise.all([loadFacilitatedPayments(), loadAudit()]);
  toast("Payment-program decision saved", "good");
}

async function startPayoutOnboarding() {
  const result = await api(accessPath("/payout-account/onboarding"), { method: "POST" });
  location.assign(result.onboarding.url);
}

async function refreshPayoutAccount({ quiet = false } = {}) {
  await api(accessPath("/payout-account/refresh"), { method: "POST" });
  await Promise.all([loadFacilitatedPayments(), loadAudit()]);
  if (!quiet) toast("Payout-account status refreshed", "good");
}

async function openPayoutDashboard() {
  const result = await api(accessPath("/payout-account/dashboard"), { method: "POST" });
  location.assign(result.url);
}

async function handleConnectCallback() {
  const url = new URL(location.href);
  const flow = url.searchParams.get("connect");
  const organizationId = url.searchParams.get("organizationId");
  if (!["return", "refresh"].includes(flow) || !organizationId) return;
  if (!accessOrganizations.length) {
    const data = await api("/api/access/organizations");
    accessOrganizations = (data.organizations || []).filter(
      (organization) => organization.permissions.includes("organization.view"),
    );
    $("accessOrganization").innerHTML = optionList(
      accessOrganizations,
      "id",
      (organization) => organization.name,
    );
  }
  if (!accessOrganizations.some((organization) => organization.id === organizationId)) {
    throw new Error("The payout-account callback does not belong to an accessible organization");
  }
  $("accessOrganization").value = organizationId;
  activateView("access", { adminSection: "payments", load: false });
  await loadAccess();
  url.searchParams.delete("connect");
  url.searchParams.delete("organizationId");
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  if (flow === "refresh") {
    await startPayoutOnboarding();
    return;
  }
  if (payoutAccountState?.canManage && payoutAccountState.connectedAccount?.providerAccountId) {
    await refreshPayoutAccount({ quiet: true });
  }
  toast(
    payoutAccountState?.connectedAccount?.onboardingState === "ready"
      ? "Stripe payout onboarding is ready"
      : "Stripe received the onboarding details; remaining requirements are shown below",
    payoutAccountState?.connectedAccount?.onboardingState === "ready" ? "good" : "neutral",
  );
}

async function loadEnterpriseAccess() {
  const loaders = [];
  identityState = null;
  serviceAccountState = [];
  scimTokenState = [];
  accessReviewState = [];
  accessRequestState = [];
  governanceReportState = null;
  if (hasAccessPermission("identity.manage")) {
    loaders.push(api(accessPath("/identity")).then((data) => { identityState = data; }));
  }
  if (hasAccessPermission("api_credentials.manage")) {
    loaders.push(api(accessPath("/service-accounts")).then((data) => {
      serviceAccountState = data.serviceAccounts || [];
    }));
  }
  if (hasAccessPermission("provisioning.manage")) {
    loaders.push(api(accessPath("/scim-tokens")).then((data) => {
      scimTokenState = data.tokens || [];
    }));
  }
  if (hasAccessPermission("access_reviews.manage")) {
    loaders.push(
      api(accessPath("/access-reviews")).then((data) => { accessReviewState = data.campaigns || []; }),
      api(accessPath("/governance-report")).then((data) => { governanceReportState = data; }),
    );
  }
  if (hasAccessPermission("access_requests.approve")) {
    loaders.push(api(accessPath("/access-requests")).then((data) => {
      accessRequestState = data.accessRequests || [];
    }));
  }
  await Promise.all(loaders);
  renderEnterpriseAccess();
}

async function loadAudit() {
  if (!hasAccessPermission("audit.view")) return;
  const data = await api(accessPath("/audit?limit=100"));
  $("auditList").innerHTML = (data.events || []).map((event) => `
    <div class="audit-row">
      <div><strong>${escapeHtml(event.action)}</strong><small>${escapeHtml(event.actorName || event.actorEmail || "System")}</small></div>
      <span>${escapeHtml(event.resourceType)}</span>
      <time>${escapeHtml(new Date(event.createdAt).toLocaleString())}</time>
    </div>
  `).join("") || '<div class="list-empty">No audit events yet.</div>';
}

async function loadAccess() {
  if (!accessOrganizations.length) {
    const data = await api("/api/access/organizations");
    accessOrganizations = (data.organizations || []).filter((organization) => organization.permissions.includes("organization.view"));
    $("accessOrganization").innerHTML = optionList(accessOrganizations, "id", (organization) => organization.name);
  }
  $("accessUnavailable").hidden = accessOrganizations.length > 0;
  $("accessContent").hidden = accessOrganizations.length === 0;
  if (!accessOrganizations.length) { syncConsoleShell(); return; }
  accessState = await api(accessPath());
  renderAccess();
  await Promise.all([
    loadAudit(),
    loadUsageAndBudgets(),
    loadVendorRelationships(),
    loadEnterpriseAccess(),
    loadFacilitatedPayments(),
    commercialConsole.then((module) => module.load($("accessOrganization").value, accessState.permissions || [])),
  ]);
  syncConsoleShell();
}

function updateAssignmentPrincipals() {
  if (!accessState) return;
  const type = $("assignmentPrincipalType").value;
  $("assignmentPrincipal").innerHTML = type === "team"
    ? optionList(accessState.teams, "id", (team) => team.name)
    : type === "service_account"
      ? optionList(accessState.serviceAccounts || [], "id", (account) => account.name)
      : optionList(accessState.members.filter((member) => member.status !== "removed"), "userId", (member) => member.displayName || member.email);
}

function updateAssignmentScopes() {
  if (!accessState) return;
  const type = $("assignmentScopeType").value;
  if (type === "organization") {
    $("assignmentScope").innerHTML = `<option value="${escapeHtml(accessState.organization.id)}">${escapeHtml(accessState.organization.name)}</option>`;
  } else if (type === "project") {
    $("assignmentScope").innerHTML = optionList(accessState.projects, "id", (project) => project.name);
  } else {
    $("assignmentScope").innerHTML = optionList(accessState.businessUnits, "id", (unit) => unit.name);
  }
}

function updateBudgetScopes() {
  if (!accessState) return;
  const type = $("budgetScopeType").value;
  $("budgetScope").disabled = type === "organization";
  if (type === "organization") {
    $("budgetScope").innerHTML = `<option value="${escapeHtml(accessState.organization.id)}">${escapeHtml(accessState.organization.name)}</option>`;
  } else if (type === "project") {
    $("budgetScope").innerHTML = optionList(accessState.projects, "id", (project) => project.name);
  } else {
    $("budgetScope").innerHTML = optionList(accessState.businessUnits, "id", (unit) => unit.name);
  }
}

async function refreshAccess() {
  accessState = await api(accessPath());
  renderAccess();
  await Promise.all([
    loadAudit(),
    loadUsageAndBudgets(),
    loadVendorRelationships(),
    loadEnterpriseAccess(),
    loadFacilitatedPayments(),
    commercialConsole.then((module) => module.load($("accessOrganization").value, accessState.permissions || [])),
  ]);
  syncConsoleShell();
}

async function createVendorRelationship(event) {
  event.preventDefault();
  const agencyOrganizationId = $("vendorExistingAgencyId").value.trim();
  const result = await api(accessPath("/vendor-relationships"), {
    method: "POST",
    body: JSON.stringify({
      ...(agencyOrganizationId ? { agencyOrganizationId } : {
        agencyName: $("vendorAgencyName").value,
        agencySlug: $("vendorAgencySlug").value,
        ownerEmail: $("vendorOwnerEmail").value,
      }),
      paymentTermsDays: Number($("vendorPaymentTerms").value || 30),
    }),
  });
  if (result.onboardingToken) {
    const inviteUrl = `${location.origin}/?invitation=${encodeURIComponent(result.onboardingToken)}`;
    $("vendorInviteResult").innerHTML = `Agency created. Share this owner invitation: <a href="${escapeHtml(inviteUrl)}">${escapeHtml(inviteUrl)}</a>`;
  } else {
    $("vendorInviteResult").textContent = "Existing agency invited. Its administrators can now accept the relationship.";
  }
  $("vendorInviteResult").hidden = false;
  event.target.reset();
  $("vendorPaymentTerms").value = "30";
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  toast("Agency relationship created", "good");
}

async function saveVendorSettings(form, relationshipId) {
  await api(accessPath(`/vendor-relationships/${encodeURIComponent(relationshipId)}`), {
    method: "PATCH",
    body: JSON.stringify({
      defaultCurrency: form.elements.defaultCurrency.value,
      paymentTermsDays: Number(form.elements.paymentTermsDays.value),
      customerVendorNumber: form.elements.customerVendorNumber.value || null,
      effectiveFrom: form.elements.effectiveFrom.value || null,
      effectiveTo: form.elements.effectiveTo.value || null,
      maximumSubcontractingDepth: Number(form.elements.maximumSubcontractingDepth.value),
      requiresLinguistApproval: form.elements.requiresLinguistApproval.checked,
      agencyMayAssignLinguists: form.elements.agencyMayAssignLinguists.checked,
    }),
  });
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  toast("Relationship settings updated", "good");
}

function commaValues(value) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

async function saveVendorScopes(form, relationshipId) {
  const structural = [...form.elements.structuralScopes.selectedOptions].map((option) => {
    const [scopeType, scopeId] = option.value.split("|");
    return { scopeType, scopeId };
  });
  const valueScopes = [
    ...commaValues(form.elements.locales.value).map((scopeValue) => ({ scopeType: "locale", scopeValue })),
    ...commaValues(form.elements.serviceTypes.value).map((scopeValue) => ({ scopeType: "service_type", scopeValue })),
    ...commaValues(form.elements.contentClassifications.value).map((scopeValue) => ({
      scopeType: "content_classification",
      scopeValue,
    })),
  ];
  await api(accessPath(`/vendor-relationships/${encodeURIComponent(relationshipId)}/scopes`), {
    method: "PUT",
    body: JSON.stringify({ scopes: [...structural, ...valueScopes] }),
  });
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  toast("Relationship scope updated", "good");
}

async function nominateVendorLinguist(form, relationshipId) {
  await api(accessPath(`/vendor-relationships/${encodeURIComponent(relationshipId)}/linguists`), {
    method: "POST",
    body: JSON.stringify({
      agencyMembershipId: form.elements.agencyMembershipId.value,
      conditions: {
        locales: commaValues(form.elements.locales.value),
      },
    }),
  });
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  toast("Linguist nominated", "good");
}

async function checkVendorEligibility(form, relationshipId) {
  const result = await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/eligibility-check`,
  ), {
    method: "POST",
    body: JSON.stringify({
      agencyMembershipId: form.elements.agencyMembershipId.value,
      projectId: form.elements.projectId.value,
      locale: form.elements.locale.value || null,
      serviceType: form.elements.serviceType.value || null,
      contentClassification: form.elements.contentClassification.value || null,
    }),
  });
  const eligibility = result.eligibility;
  const output = form.parentElement.querySelector(".vendor-eligibility-result");
  output.innerHTML = `
    <div class="vendor-eligibility-heading">
      ${badge(
        eligibility.eligibleForAssignment ? "Ready for assignment" : "Not ready",
        eligibility.eligibleForAssignment ? "good" : "warn",
      )}
      <span>Customer content remains blocked until a work assignment exists.</span>
    </div>
    ${eligibility.denialReasons.length ? `
      <ul>
        ${eligibility.denialReasons.map((reason) => `
          <li><code>${escapeHtml(reason.code)}</code> ${escapeHtml(reason.message)}</li>
        `).join("")}
      </ul>
    ` : `
      <p>All Phase 4 eligibility checks pass. The remaining blocker is
        <code>${escapeHtml(eligibility.contentAccess.code)}</code>.
      </p>
    `}
  `;
  output.hidden = false;
}

async function transitionVendorRelationship(relationshipId, status) {
  if (status === "terminated" && !window.confirm("Terminate this agency relationship? This cannot be undone.")) return;
  await api(accessPath(`/vendor-relationships/${encodeURIComponent(relationshipId)}/transitions`), {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  toast(`Relationship ${status}`, status === "active" ? "good" : "neutral");
}

async function updateVendorLinguist(relationshipId, approvedLinguistId, status) {
  if (status === "revoked" && !window.confirm("Revoke this linguist's customer approval?")) return;
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/linguists/${encodeURIComponent(approvedLinguistId)}`,
  ), {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  toast(`Linguist ${status}`, status === "approved" ? "good" : "neutral");
}

function readRateCardForm(form) {
  const lines = [...form.querySelectorAll(".rate-line-row")].map((row) => ({
    serviceType: row.querySelector('[name="serviceType"]').value,
    unitType: row.querySelector('[name="unitType"]').value,
    unitRate: row.querySelector('[name="unitRate"]').value,
    sourceLocale: row.querySelector('[name="sourceLocale"]').value || null,
    targetLocale: row.querySelector('[name="targetLocale"]').value || null,
    businessUnitId: row.querySelector('[name="businessUnitId"]').value || null,
    projectId: row.querySelector('[name="projectId"]').value || null,
    contentType: row.querySelector('[name="contentType"]').value || null,
    matchBand: row.querySelector('[name="matchBand"]').value || null,
    minimumUnits: row.querySelector('[name="minimumUnits"]').value || null,
  }));
  return {
    currency: form.elements.currency.value,
    paymentTermsDays: form.elements.paymentTermsDays.value === ""
      ? null
      : Number(form.elements.paymentTermsDays.value),
    effectiveFrom: form.elements.effectiveFrom.value || null,
    effectiveTo: form.elements.effectiveTo.value || null,
    minimumChargeMinor: form.elements.minimumChargeMinor.value === ""
      ? null
      : Number(form.elements.minimumChargeMinor.value),
    notes: form.elements.notes.value || null,
    lines,
  };
}

async function saveRateCard(form, relationshipId) {
  const rateCardId = form.dataset.rateCardId;
  const suffix = rateCardId ? `/rate-cards/${encodeURIComponent(rateCardId)}` : "/rate-cards";
  await api(
    accessPath(`/vendor-relationships/${encodeURIComponent(relationshipId)}${suffix}`),
    {
      method: rateCardId ? "PUT" : "POST",
      body: JSON.stringify(readRateCardForm(form)),
    },
  );
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  toast(rateCardId ? "Rate-card draft saved" : "Rate-card draft created", "good");
}

async function transitionRateCard(relationshipId, rateCardId, status) {
  let reason = null;
  if (status === "rejected") {
    reason = window.prompt("Why is this rate card being rejected?");
    if (reason == null) return;
    if (!reason.trim()) throw new Error("A rejection reason is required");
  }
  if (
    status === "approved"
    && !window.confirm("Approve this rate card as the current commercial version?")
  ) return;
  await api(
    accessPath(
      `/vendor-relationships/${encodeURIComponent(relationshipId)}/rate-cards/${encodeURIComponent(rateCardId)}/transitions`,
    ),
    {
      method: "POST",
      body: JSON.stringify({ status, ...(reason ? { reason: reason.trim() } : {}) }),
    },
  );
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  toast(`Rate card ${status}`, status === "approved" ? "good" : "neutral");
}

function idempotencyKey(prefix) {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

async function refreshVendorCommercials(message) {
  await Promise.all([loadVendorRelationships(), loadAudit()]);
  if (message) toast(message, "good");
}

async function createWorkOrder(form, relationshipId) {
  const sourceStringIds = form.elements.sourceStringIds.value
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/work-orders`,
  ), {
    method: "POST",
    body: JSON.stringify({
      projectId: form.elements.projectId.value,
      title: form.elements.title.value,
      description: form.elements.description.value || null,
      serviceType: form.elements.serviceType.value,
      unitType: form.elements.unitType.value,
      sourceLocale: form.elements.sourceLocale.value || null,
      targetLocale: form.elements.targetLocale.value,
      estimatedUnits: form.elements.estimatedUnits.value || null,
      dueAt: form.elements.dueAt.value
        ? new Date(form.elements.dueAt.value).toISOString()
        : null,
      sourceStringIds,
    }),
  });
  await refreshVendorCommercials("Work-order draft created");
}

async function transitionWorkOrder(relationshipId, workOrderId, action) {
  let reason = null;
  if (action === "quality_reject") {
    reason = window.prompt("What changes are required?");
  } else if (action === "cancel") {
    reason = window.prompt("Why is this work order being canceled?");
  }
  if (["quality_reject", "cancel"].includes(action) && reason == null) return;
  if (reason != null && !reason.trim()) throw new Error("A reason is required");
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/work-orders/${encodeURIComponent(workOrderId)}/transitions`,
  ), {
    method: "POST",
    body: JSON.stringify({ action, ...(reason ? { reason: reason.trim() } : {}) }),
  });
  await refreshVendorCommercials(`Work order ${action.replaceAll("_", " ")}`);
}

async function assignWorkOrder(form, relationshipId, workOrderId) {
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/work-orders/${encodeURIComponent(workOrderId)}/assignments`,
  ), {
    method: "POST",
    body: JSON.stringify({
      agencyMembershipId: form.elements.agencyMembershipId.value,
      assignmentRole: form.elements.assignmentRole.value,
    }),
  });
  await refreshVendorCommercials("Linguist assigned");
}

async function revokeWorkAssignment(relationshipId, workOrderId, assignmentId) {
  const reason = window.prompt("Why is this assignment being revoked?");
  if (reason == null) return;
  if (!reason.trim()) throw new Error("A revocation reason is required");
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/work-orders/${encodeURIComponent(workOrderId)}/assignments/${encodeURIComponent(assignmentId)}`,
  ), {
    method: "PATCH",
    body: JSON.stringify({ reason: reason.trim() }),
  });
  await refreshVendorCommercials("Assignment revoked");
}

async function recordWorkAdjustment(form, relationshipId, workOrderId) {
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/work-orders/${encodeURIComponent(workOrderId)}/adjustments`,
  ), {
    method: "POST",
    body: JSON.stringify({
      amountMinor: Number(form.elements.amountMinor.value),
      reason: form.elements.reason.value,
      idempotencyKey: idempotencyKey("work-adjustment"),
    }),
  });
  await refreshVendorCommercials("Payable adjustment recorded");
}

async function openWorkDispute(form, relationshipId, workOrderId) {
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/work-orders/${encodeURIComponent(workOrderId)}/disputes`,
  ), {
    method: "POST",
    body: JSON.stringify({ reason: form.elements.reason.value }),
  });
  await refreshVendorCommercials("Dispute opened");
}

async function resolveWorkDispute(relationshipId, workOrderId, disputeId) {
  const resolution = window.prompt("How was this dispute resolved?");
  if (resolution == null) return;
  if (!resolution.trim()) throw new Error("A resolution is required");
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/work-orders/${encodeURIComponent(workOrderId)}/disputes/${encodeURIComponent(disputeId)}`,
  ), {
    method: "PATCH",
    body: JSON.stringify({ status: "resolved", resolution: resolution.trim() }),
  });
  await refreshVendorCommercials("Dispute resolved");
}

async function createPayableStatement(form, relationshipId) {
  const workOrderIds = [...form.elements.workOrderIds.selectedOptions].map(
    (option) => option.value,
  );
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/payable-statements`,
  ), {
    method: "POST",
    body: JSON.stringify({
      workOrderIds,
      periodStart: form.elements.periodStart.value,
      periodEnd: form.elements.periodEnd.value,
      notes: form.elements.notes.value || null,
    }),
  });
  await refreshVendorCommercials("Draft statement created");
}

async function transitionPayableStatement(relationshipId, statementId, action) {
  let reason = null;
  if (action === "void") {
    reason = window.prompt("Why is this statement being voided?");
    if (reason == null) return;
    if (!reason.trim()) throw new Error("A void reason is required");
  }
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/payable-statements/${encodeURIComponent(statementId)}/transitions`,
  ), {
    method: "POST",
    body: JSON.stringify({ action, ...(reason ? { reason: reason.trim() } : {}) }),
  });
  await refreshVendorCommercials(`Statement ${action === "finalize" ? "finalized" : "voided"}`);
}

async function recordStatementPayment(form, relationshipId, statementId) {
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/payable-statements/${encodeURIComponent(statementId)}/payments`,
  ), {
    method: "POST",
    body: JSON.stringify({
      amountMinor: Number(form.elements.amountMinor.value),
      paymentMethod: form.elements.paymentMethod.value,
      externalReference: form.elements.externalReference.value,
      paidAt: new Date(form.elements.paidAt.value).toISOString(),
      idempotencyKey: idempotencyKey("external-payment"),
    }),
  });
  await refreshVendorCommercials("Payment record saved");
}

async function startFacilitatedStatementPayment(relationshipId, statementId) {
  const result = await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/payable-statements/${encodeURIComponent(statementId)}/payment-session`,
  ), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey("statement-checkout"),
    },
    body: "{}",
  });
  if (!result.attempt?.url) {
    throw new Error(
      result.attempt?.failureMessage
      || `Payment attempt is ${result.attempt?.state || "not redirectable"}`,
    );
  }
  window.location.assign(result.attempt.url);
}

async function requestFacilitatedRefund(form, relationshipId, statementId) {
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/payable-statements/${encodeURIComponent(statementId)}/refund-requests`,
  ), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey("statement-refund"),
    },
    body: JSON.stringify({
      amountMinor: form.elements.amountMinor.value,
      reason: form.elements.reason.value,
      reference: form.elements.reference.value,
    }),
  });
  await refreshVendorCommercials("Refund request submitted for platform approval");
}

async function reconcileFacilitatedPayments() {
  const result = await api("/api/platform/facilitated-payments/reconcile", {
    method: "POST",
  });
  const failed = (result.outcomes || []).filter((outcome) => outcome.status === "failed").length;
  await loadFacilitatedPayments();
  toast(
    failed
      ? `Reconciliation completed with ${failed} failures`
      : `Reconciled ${(result.outcomes || []).length} payment attempts`,
    failed ? "warn" : "good",
  );
}

function handleVendorPaymentCallback() {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get("vendorPayment");
  if (!["success", "cancel"].includes(outcome)) return;
  toast(
    outcome === "success"
      ? "Stripe received the payment. Status will update after provider confirmation."
      : "Checkout was closed. An open session remains reusable until Stripe expires it.",
    outcome === "success" ? "good" : "neutral",
  );
  url.searchParams.delete("vendorPayment");
  url.searchParams.delete("attemptId");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

async function decideStatementPayment(
  relationshipId,
  statementId,
  paymentId,
  status,
) {
  let reason = null;
  if (status === "rejected") {
    reason = window.prompt("Why is this payment record being rejected?");
    if (reason == null) return;
    if (!reason.trim()) throw new Error("A rejection reason is required");
  }
  await api(accessPath(
    `/vendor-relationships/${encodeURIComponent(relationshipId)}/payable-statements/${encodeURIComponent(statementId)}/payments/${encodeURIComponent(paymentId)}`,
  ), {
    method: "PATCH",
    body: JSON.stringify({ status, ...(reason ? { reason: reason.trim() } : {}) }),
  });
  await refreshVendorCommercials(`Payment ${status}`);
}

function renderPersonalWorkList() {
  $("personalWorkList").innerHTML = personalWorkState.map((assignment) => `
    <button type="button"
            class="personal-assignment ${assignment.id === selectedWorkAssignmentId ? "active" : ""}"
            data-assignment-id="${escapeHtml(assignment.id)}">
      <strong>#${escapeHtml(assignment.workOrderNumber)} · ${escapeHtml(assignment.title)}</strong>
      <span>${escapeHtml(assignment.customerName)} · ${escapeHtml(assignment.projectName)}</span>
      <small>${escapeHtml(assignment.sourceLocale || "any")} → ${escapeHtml(assignment.targetLocale)}
        · ${escapeHtml(assignment.itemCount)} strings · ${escapeHtml(assignment.workOrderStatus)}
      </small>
    </button>
  `).join("") || `
    <div class="list-empty">
      No assignments are available. Access appears only after an approved linguist is assigned.
    </div>
  `;
}

function renderPersonalWorkDetail(assignment) {
  const editable = assignment.assignmentStatus === "active"
    && ["accepted", "in_progress"].includes(assignment.workOrderStatus);
  $("personalWorkEmpty").hidden = true;
  $("personalWorkDetail").hidden = false;
  $("personalWorkDetail").innerHTML = `
    <header class="personal-work-header">
      <div>
        <p class="eyebrow">${escapeHtml(assignment.customerName)} · ${escapeHtml(assignment.projectName)}</p>
        <h1>#${escapeHtml(assignment.workOrderNumber)} · ${escapeHtml(assignment.title)}</h1>
        <p class="section-copy">${escapeHtml(assignment.sourceLocale || "any")} → ${escapeHtml(assignment.targetLocale)}
          · ${escapeHtml(assignment.serviceType)}
          ${assignment.dueAt ? ` · Due ${escapeHtml(new Date(assignment.dueAt).toLocaleString())}` : ""}
        </p>
      </div>
      ${badge(assignment.workOrderStatus, workStatusTone(assignment.workOrderStatus))}
    </header>
    <div class="personal-work-actions">
      ${assignment.workOrderStatus === "accepted" && assignment.assignmentStatus === "active" ? `
        <button type="button" id="personalWorkStart" class="primary">Start work</button>
      ` : ""}
      ${editable ? `
        <form id="personalWorkSubmit" class="inline-form">
          <input name="deliveredUnits" inputmode="decimal" placeholder="Delivered units" required>
          <input name="notes" maxlength="5000" placeholder="Delivery notes">
          <button class="primary" type="submit">Submit delivery</button>
        </form>
      ` : ""}
    </div>
    <div class="personal-work-items">
      ${selectedWorkItems.map((item) => `
        <article class="personal-work-item" data-source-string-id="${escapeHtml(item.id)}">
          <label>
            <span>Source</span>
            <textarea readonly>${escapeHtml(item.sourceText)}</textarea>
          </label>
          <label>
            <span>${escapeHtml(assignment.targetLocale)}</span>
            <textarea name="translationText" ${editable ? "" : "readonly"}>${escapeHtml(item.translationText || "")}</textarea>
          </label>
          ${editable ? '<button type="button" class="personal-translation-save">Save translation</button>' : ""}
        </article>
      `).join("") || '<div class="list-empty">This work order has no attached strings.</div>'}
    </div>
  `;
}

async function loadPersonalWork() {
  const data = await api("/api/work/assignments");
  personalWorkState = data.assignments || [];
  if (
    selectedWorkAssignmentId
    && !personalWorkState.some((item) => item.id === selectedWorkAssignmentId)
  ) {
    selectedWorkAssignmentId = null;
    selectedWorkItems = [];
  }
  renderPersonalWorkList();
  if (selectedWorkAssignmentId) {
    const selected = personalWorkState.find((item) => item.id === selectedWorkAssignmentId);
    if (selected) renderPersonalWorkDetail(selected);
  }
  syncConsoleShell();
}

async function openPersonalWorkAssignment(assignmentId) {
  const data = await api(`/api/work/assignments/${encodeURIComponent(assignmentId)}/content`);
  selectedWorkAssignmentId = assignmentId;
  selectedWorkItems = data.items || [];
  renderPersonalWorkList();
  renderPersonalWorkDetail(
    personalWorkState.find((assignment) => assignment.id === assignmentId),
  );
}

async function savePersonalTranslation(sourceStringId, text) {
  const assignment = personalWorkState.find(
    (item) => item.id === selectedWorkAssignmentId,
  );
  await api(
    `/api/work/assignments/${encodeURIComponent(selectedWorkAssignmentId)}/content/${encodeURIComponent(sourceStringId)}/translations/${encodeURIComponent(assignment.targetLocale)}`,
    {
      method: "PUT",
      body: JSON.stringify({ text }),
    },
  );
  await openPersonalWorkAssignment(selectedWorkAssignmentId);
  toast("Translation saved", "good");
}

async function startPersonalWork() {
  await api(`/api/work/assignments/${encodeURIComponent(selectedWorkAssignmentId)}/start`, {
    method: "POST",
  });
  await loadPersonalWork();
  await openPersonalWorkAssignment(selectedWorkAssignmentId);
  toast("Work started", "good");
}

async function submitPersonalWork(form) {
  await api(`/api/work/assignments/${encodeURIComponent(selectedWorkAssignmentId)}/submit`, {
    method: "POST",
    body: JSON.stringify({
      deliveredUnits: form.elements.deliveredUnits.value,
      notes: form.elements.notes.value || null,
      idempotencyKey: idempotencyKey("work-delivery"),
    }),
  });
  await loadPersonalWork();
  await openPersonalWorkAssignment(selectedWorkAssignmentId);
  toast("Delivery submitted for quality review", "good");
}

async function createBusinessUnit(event) {
  event.preventDefault();
  await api(accessPath("/business-units"), { method: "POST", body: JSON.stringify({ name: $("businessUnitName").value }) });
  event.target.reset();
  await refreshAccess();
  toast("Business unit created", "good");
}

async function inviteMember(event) {
  event.preventDefault();
  const result = await api(accessPath("/invitations"), {
    method: "POST",
    body: JSON.stringify({ email: $("inviteEmail").value, displayName: $("inviteName").value, membershipType: $("inviteType").value }),
  });
  const inviteUrl = `${location.origin}/?invitation=${encodeURIComponent(result.onboardingToken)}`;
  $("inviteResult").innerHTML = `Invitation created. Share this one-time link: <a href="${escapeHtml(inviteUrl)}">${escapeHtml(inviteUrl)}</a>`;
  $("inviteResult").hidden = false;
  event.target.reset();
  await refreshAccess();
}

async function createTeam(event) {
  event.preventDefault();
  await api(accessPath("/teams"), { method: "POST", body: JSON.stringify({ name: $("teamName").value }) });
  event.target.reset();
  await refreshAccess();
  toast("Team created", "good");
}

async function createRoleAssignment(event) {
  event.preventDefault();
  const locales = $("assignmentLocales").value.split(",").map((locale) => locale.trim()).filter(Boolean);
  await api(accessPath("/role-assignments"), {
    method: "POST",
    body: JSON.stringify({
      principalType: $("assignmentPrincipalType").value,
      principalId: $("assignmentPrincipal").value,
      roleId: $("assignmentRole").value,
      scopeType: $("assignmentScopeType").value,
      scopeId: $("assignmentScope").value,
      inheritToChildren: $("assignmentInherit").checked,
      conditions: locales.length ? { locales } : {},
    }),
  });
  await refreshAccess();
  toast("Role assigned", "good");
}

async function saveIdentityPolicy(event) {
  event.preventDefault();
  await api(accessPath("/identity/policy"), {
    method: "PATCH",
    body: JSON.stringify({
      ssoRequired: $("identitySsoRequired").checked,
      passwordLoginEnabled: !$("identitySsoRequired").checked,
      jitMembershipEnabled: $("identityJitEnabled").checked,
      jitMembershipType: $("identityJitType").value,
    }),
  });
  await loadEnterpriseAccess();
  toast("Identity policy updated", "good");
}

async function claimIdentityDomain(event) {
  event.preventDefault();
  const result = await api(accessPath("/identity/domains"), {
    method: "POST",
    body: JSON.stringify({ domain: $("identityDomain").value }),
  });
  $("identityDnsResult").textContent = `Add ${result.dns.type} ${result.dns.name} with value ${result.dns.value}`;
  $("identityDnsResult").hidden = false;
  event.target.reset();
  await loadEnterpriseAccess();
}

async function createIdentityConnection(event) {
  event.preventDefault();
  await api(accessPath("/identity/connections"), {
    method: "POST",
    body: JSON.stringify({
      displayName: $("identityConnectionName").value,
      connectionType: $("identityConnectionType").value,
      cognitoProviderName: $("identityProviderName").value,
    }),
  });
  event.target.reset();
  await loadEnterpriseAccess();
  toast("Identity connection created", "good");
}

async function createIdentityRecovery(event) {
  event.preventDefault();
  await api(accessPath("/identity/recovery-grants"), {
    method: "POST",
    body: JSON.stringify({
      userId: $("identityRecoveryUser").value,
      reason: $("identityRecoveryReason").value,
      expiresAt: new Date($("identityRecoveryExpiry").value).toISOString(),
    }),
  });
  event.target.reset();
  await loadEnterpriseAccess();
  toast("Recovery login granted", "good");
}

function showOneTimeCredential(node, label, value) {
  node.innerHTML = `${escapeHtml(label)}: <code>${escapeHtml(value)}</code>. Copy it now; it will not be shown again.`;
  node.hidden = false;
}

async function createServiceAccount(event) {
  event.preventDefault();
  const result = await api(accessPath("/service-accounts"), {
    method: "POST",
    body: JSON.stringify({ name: $("serviceAccountName").value }),
  });
  showOneTimeCredential($("serviceCredentialResult"), "Service credential", result.credential.token);
  event.target.reset();
  await loadEnterpriseAccess();
}

async function createScimToken(event) {
  event.preventDefault();
  const result = await api(accessPath("/scim-tokens"), {
    method: "POST",
    body: JSON.stringify({ name: $("scimTokenName").value }),
  });
  showOneTimeCredential(
    $("scimTokenResult"),
    `SCIM token for ${location.origin}${result.baseUrl}`,
    result.scimToken.token,
  );
  event.target.reset();
  await loadEnterpriseAccess();
}

async function createAccessReview(event) {
  event.preventDefault();
  await api(accessPath("/access-reviews"), {
    method: "POST",
    body: JSON.stringify({
      name: $("accessReviewName").value,
      reviewerUserId: $("accessReviewReviewer").value,
      dueAt: $("accessReviewDue").value
        ? new Date($("accessReviewDue").value).toISOString()
        : null,
    }),
  });
  event.target.reset();
  await loadEnterpriseAccess();
  toast("Access review created", "good");
}

async function loadAccessReviewItems(campaignId) {
  selectedAccessReviewId = campaignId;
  const data = await api(accessPath(`/access-reviews/${encodeURIComponent(campaignId)}/items`));
  $("accessReviewItemList").innerHTML = (data.items || []).map((item) => {
    const snapshot = item.assignmentSnapshot || {};
    return `
      <div class="management-row">
        <div><strong>${escapeHtml(accessName(snapshot.principal_type, snapshot.principal_id))}</strong><small>${escapeHtml(snapshot.scope_type || "scope")}</small></div>
        ${badge(item.decision, item.decision === "retain" ? "good" : item.decision === "revoke" ? "bad" : "warn")}
        ${item.decision === "pending" ? `<span><button class="access-review-decision" data-id="${escapeHtml(item.id)}" data-decision="retain" type="button">Retain</button><button class="access-review-decision danger" data-id="${escapeHtml(item.id)}" data-decision="revoke" type="button">Revoke</button></span>` : ""}
      </div>
    `;
  }).join("") || '<div class="list-empty">This campaign contains no grants.</div>';
}

async function createBudget(event) {
  event.preventDefault();
  const scopeType = $("budgetScopeType").value;
  await api(accessPath("/budgets"), {
    method: "POST",
    body: JSON.stringify({
      scopeType,
      scopeId: scopeType === "organization" ? null : $("budgetScope").value,
      metricKey: $("budgetMetric").value,
      limitQuantity: $("budgetLimit").value,
      warningPercent: Number($("budgetWarning").value),
      enforcement: $("budgetEnforcement").value,
      period: $("budgetPeriod").value,
      reason: $("budgetReason").value,
    }),
  });
  event.target.reset();
  $("budgetWarning").value = "80";
  await Promise.all([loadUsageAndBudgets(), loadAudit()]);
  toast("Usage budget set", "good");
}

async function loadStats() {
  const data = await api(`/api/stats?${projectParams({ locale: selectedLocale })}`);
  const stats = data.stats || {};
  const total = Number(stats.totalStrings || 0);
  const translated = Number(stats.translatedStrings || 0);
  const verified = Number(stats.verifiedStrings || 0);
  const percent = total ? Math.round((translated / total) * 100) : 0;
  const inReview = Number(stats.needsReviewStrings || 0) + Number(stats.rejectedStrings || 0);
  $("stats").innerHTML = `
    <div><strong>${translated}/${total}</strong><span>translated</span></div>
    <div><strong>${verified}</strong><span>verified</span></div>
    <div><strong>${inReview}</strong><span>in review</span></div>
    <div><strong>${escapeHtml(stats.missingStrings || 0)}</strong><span>missing</span></div>
    <div><strong>${percent}%</strong><span>coverage</span></div>
  `;
}

async function loadStrings() {
  const params = new URLSearchParams({
    project: selectedProjectSlug,
    locale: selectedLocale,
    search: $("search").value,
    status: $("status").value,
    facet: selectedSourceFacet,
  });
  const data = await api(`/api/strings?${params}`);
  // When the selected facet no longer exists (project switch, source
  // removed), renderSourceFacets falls back to UI strings — refetch so the
  // list matches the selection. At most one level deep: "ui" always exists.
  if (renderSourceFacets(data.dataSources || [])) return loadStrings();
  renderStringList(data.strings || []);
  // Spec 08: enum fields get a table view, not a queue — load the grids when
  // a data-source facet is active.
  if (selectedFacetSourceName()) {
    await loadEnumGrids();
  } else {
    $("enumGrids").hidden = true;
    $("enumGrids").innerHTML = "";
  }
  await loadStats();
}

// Returns true when the stale selected facet had to be reset to the default.
function renderSourceFacets(dataSources) {
  const select = $("sourceFacet");
  const options = [
    { value: "ui", label: "UI strings" },
    { value: "all", label: "All" },
    ...dataSources.map((source) => ({ value: `source:${source}`, label: source })),
  ];
  const reset = !options.some((option) => option.value === selectedSourceFacet);
  if (reset) selectedSourceFacet = "ui";
  select.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join("");
  select.value = selectedSourceFacet;
  return reset;
}

function renderStringList(strings) {
  if (!strings.length) {
    $("stringList").innerHTML = `<div class="list-empty">No strings match this filter.</div>`;
    return;
  }

  $("stringList").innerHTML = strings.map((item) => {
    const status = item.translationText ? item.humanStatus || "pending" : "missing";
    const passTone = item.pass1Status === "degraded" || item.pass2Status === "degraded" ? "warn" : "neutral";
    // P-06: provenance + occurrence badges for the review queue — reviewers
    // see how the text got here (mt/carryover/human), the provider confidence,
    // and how often users see the string (the queue's sort key).
    const provenance = item.translationText ? item.translationProvider || item.translationSource : "";
    const confidence = typeof item.translationConfidence === "number"
      ? badge(`conf ${item.translationConfidence.toFixed(2)}`, item.translationConfidence < 0.5 ? "warn" : "neutral")
      : "";
    const occurrences = Number(item.occurrences || 0) > 1 ? badge(`${item.occurrences}×`) : "";
    // Spec 08: dynamic rows carry their data source + reach (the dynamic
    // queue's sort key — the template shared by 400 listings gets eyes before
    // the one-off). Masked templates render placeholders as typed chips.
    const dynamicBadges = item.isDynamic
      ? `${badge(item.dataSource)}${badge(`reach ${Number(item.reach || 0)}`, "neutral")}`
      : "";
    const sourceHtml = Array.isArray(item.maskNames) && item.maskNames.length
      ? chippedHtml(item.sourceText, item.maskNames)
      : escapeHtml(item.sourceText);
    return `
      <button class="string-item ${item.id === selectedStringId ? "active" : ""}" data-id="${escapeHtml(item.id)}">
        <span class="item-source">${sourceHtml}</span>
        <span class="item-translation">${escapeHtml(item.translationText || "Missing translation")}</span>
        <span class="item-meta">
          ${badge(status, statusClass(status))}
          ${dynamicBadges}
          ${provenance ? badge(provenance) : ""}
          ${confidence}
          ${occurrences}
          ${badge(`${item.pass1Status}/${item.pass2Status}`, passTone)}
          ${item.shape ? badge(item.shape) : ""}
        </span>
      </button>
    `;
  }).join("");
}

// ---- spec 08: enum grid — one compact source×locale table per field -------------

async function loadEnumGrids() {
  const source = selectedFacetSourceName();
  if (!source) return;
  const data = await api(`/api/dynamic-enums?${projectParams({ source })}`);
  renderEnumGrids(data.fields || []);
}

function renderEnumGrids(fields) {
  const container = $("enumGrids");
  if (!fields.length) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const canApprove = hasProjectPermission("translations.approve");
  container.hidden = false;
  container.innerHTML = fields.map((group, index) => {
    const locales = group.locales;
    const rows = group.entries.map((entry) => `
      <tr>
        <th scope="row">${escapeHtml(entry.sourceText)}<span class="enum-reach">${Number(entry.reach || 0)}</span></th>
        ${locales.map((locale) => {
          const cell = entry.translations[locale];
          if (!cell) return '<td class="enum-cell missing">—</td>';
          return `<td class="enum-cell ${statusClass(cell.humanStatus)}">${escapeHtml(cell.text)}${cell.humanStatus === "verified" ? '<span class="enum-verified">✓</span>' : ""}</td>`;
        }).join("")}
      </tr>
    `).join("");
    return `
      <section class="enum-grid" data-field-index="${index}">
        <div class="section-heading">
          <h2>${escapeHtml(group.field)} <span class="enum-count">${group.entries.length} values</span></h2>
          ${canApprove ? `<button class="enum-verify-all primary" data-field-index="${index}">Verify all</button>` : ""}
        </div>
        <div class="enum-grid-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                ${locales.map((locale) => `<th scope="col">${escapeHtml(locale)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    `;
  }).join("");
  enumGridFields = fields;
}

// Spec 08: bulk verify writes the SAME per-row verified statuses as the single
// approve button — one review sitting for a whole vocabulary, no new
// verification semantics.
async function bulkVerifyEnumField(fieldIndex) {
  const group = enumGridFields[fieldIndex];
  if (!group) return;
  const items = group.entries.flatMap((entry) =>
    group.locales
      .filter((locale) => entry.translations[locale] && entry.translations[locale].humanStatus !== "verified")
      .map((locale) => ({ sourceId: entry.sourceId, locale })));
  if (!items.length) {
    toast("Every translated value in this field is already verified", "neutral");
    return;
  }
  const locales = [...new Set(items.map((item) => item.locale))].join(",");
  const outcome = await api(`/api/translations/bulk-approve?${projectParams({ locales })}`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
  toast(`Verified ${outcome.verified} translations in ${group.field}`, "good");
  await loadStrings();
}

async function loadDetail(id = selectedStringId) {
  if (!id) return;
  selectedStringId = id;
  selectedDetail = await api(`/api/strings/${id}`);
  $("emptyState").hidden = true;
  $("detail").hidden = false;
  renderDetail(selectedDetail);
  await loadStrings();
}

function renderDetail(data) {
  const source = data.string;
  const translation = data.translations.find((item) => item.locale === selectedLocale) || null;
  const status = translation ? translation.humanStatus : "missing";
  const sourceMeta = [
    source.shape ? badge(source.shape) : "",
    source.limitChars ? badge(`${source.limitChars} chars`) : "",
    source.purpose ? badge(source.purpose) : "",
    source.visualContext ? badge("visual context") : "",
    // Spec 08: dynamic provenance — the data source and the entry's reach.
    source.isDynamic ? badge(source.dataSource) : "",
    source.isDynamic ? badge(`reach ${Number(source.reach || 0)}`) : "",
    source.dynamicEnum ? badge("enum") : "",
  ].filter(Boolean).join("");

  $("sourceMeta").innerHTML = sourceMeta;
  $("sourceText").textContent = source.sourceText;
  $("sourceHash").textContent = source.sourceHash;
  $("sourceReadonly").value = source.sourceText;
  $("translationLabel").textContent = `${selectedLocale} translation`;
  $("translationText").value = translation?.text || "";
  $("translationStatus").textContent = translation ? `${translation.source} / ${translation.humanStatus}` : "Missing";
  $("translationStatus").className = `status-pill ${statusClass(status)}`;
  // P-06: provenance (provider/model/confidence) + occurrence count, and the
  // reviewer note when the current text was rejected.
  const occurrenceCount = (data.contexts || []).length;
  $("translationProvenance").innerHTML = translation
    ? [
        translation.provider ? badge(translation.provider) : "",
        translation.model ? badge(translation.model) : "",
        typeof translation.confidence === "number"
          ? badge(`confidence ${Number(translation.confidence).toFixed(2)}`, translation.confidence < 0.5 ? "warn" : "neutral")
          : "",
        occurrenceCount > 1 ? badge(`${occurrenceCount} occurrences`) : "",
      ].filter(Boolean).join("")
    : "";
  $("reviewNote").hidden = !translation?.reviewNote;
  $("reviewNote").textContent = translation?.reviewNote ? `Rejected: ${translation.reviewNote}` : "";
  $("approveTranslation").disabled = !translation || translation.humanStatus === "verified";
  $("rejectTranslation").disabled = !translation || translation.humanStatus === "rejected";
  updateCharBudget();
  updateChipPreviews();

  renderContextPane(data);
  renderAnalysisPane("panel-pass1", data.analysis.pass1, "Developer intent");
  renderAnalysisPane("panel-pass2", data.analysis.pass2, "Presentation constraints");
  renderHistoryPane(data.revisions || []);
}

function updateCharBudget() {
  if (!selectedDetail) return;
  const limit = selectedDetail.string.limitChars;
  const count = $("translationText").value.length;
  if (!limit) {
    $("charBudget").textContent = `${count} characters`;
    $("charBudget").className = "";
    return;
  }
  const over = count > limit;
  $("charBudget").textContent = `${count}/${limit} characters`;
  $("charBudget").className = over ? "over-budget" : "";
}

// Spec 08: chip previews for masked templates — source and translation panes
// show typed chips, with missing chips highlighted in the source preview the
// moment the translation drops one (before the validator even runs).
function updateChipPreviews() {
  const source = selectedDetail?.string;
  const maskNames = Array.isArray(source?.maskNames) ? source.maskNames : [];
  const masked = maskNames.length > 0;
  $("sourceChips").hidden = !masked;
  $("translationChips").hidden = !masked;
  if (!masked) return;
  const sourceText = source.sourceText;
  const translationText = $("translationText").value;
  const mismatch = chipMismatch(sourceText, translationText);
  $("sourceChips").innerHTML = chippedHtml(sourceText, maskNames, mismatch.missing);
  $("translationChips").innerHTML = translationText
    ? chippedHtml(translationText, maskNames, mismatch.extra)
      + (mismatch.ok ? "" : `<span class="chip-warning">missing: ${escapeHtml(mismatch.missing.join(" ") || "—")}${mismatch.extra.length ? ` · extra: ${escapeHtml(mismatch.extra.join(" "))}` : ""}</span>`)
    : `<span class="chip-warning">No translation yet.</span>`;
}

function renderContextPane(data) {
  const contexts = data.contexts || [];
  const source = data.string;
  const sourceFacts = [
    ["Shape", source.shape],
    ["Purpose", source.purpose],
    ["Visual context", source.visualContext],
    ["Character limit", source.limitChars],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");

  $("panel-context").innerHTML = `
    <div class="fact-grid">
      ${sourceFacts.map(([label, value]) => `
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join("") || `<div><span>Context</span><strong>None stored</strong></div>`}
    </div>
    <div class="context-list">
      ${contexts.length ? contexts.map((ctx, index) => renderContextVariant(ctx, index)).join("") : `<div class="list-empty">No extracted variants.</div>`}
    </div>
  `;
}

function renderContextVariant(ctx, index) {
  const rows = [
    ["File", ctx.file_path],
    ["Shape", ctx.shape],
    ["Purpose", ctx.purpose],
    ["Visual", ctx.visual_context],
    ["Code", ctx.code_context],
    ["UI", ctx.ui_context],
    ["App state", ctx.app_state_context],
  ].filter(([, value]) => value);

  return `
    <details class="context-variant" ${index === 0 ? "open" : ""}>
      <summary>Context ${index + 1}${ctx.file_path ? ` · ${escapeHtml(ctx.file_path)}` : ""}</summary>
      <dl>
        ${rows.map(([label, value]) => `
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        `).join("")}
      </dl>
      <pre>${escapeHtml(jsonText(ctx.raw || ctx))}</pre>
    </details>
  `;
}

function renderAnalysisPane(id, analysis, label) {
  if (!analysis) {
    $(id).innerHTML = `<div class="list-empty">${escapeHtml(label)} is missing.</div>`;
    return;
  }
  const data = analysis.data || {};
  const summary = id === "panel-pass1"
    ? [
        ["Purpose", data.functional_context?.purpose],
        ["UI shape", data.functional_context?.ui_shape],
        ["Interaction", data.functional_context?.interaction],
        ["Activity", data.narrative_context?.current_activity],
        ["Emotion", data.emotional_intent?.primary_emotion],
        ["Reaction", data.emotional_intent?.desired_player_reaction],
      ]
    : [
        ["Visual budget", data.spatial_budget?.visual_entropy_budget],
        ["Expansion", data.spatial_budget?.recommended_expansion_percentage],
        ["Layout", data.spatial_budget?.preferred_layout],
        ["Player state", data.cognitive_budget?.player_state],
        ["Reading", data.cognitive_budget?.reading_speed_requirement],
      ];

  $(id).innerHTML = `
    <div class="analysis-top">
      ${badge(analysis.status, statusClass(analysis.status))}
      ${badge(analysis.promptVersion || "unknown")}
      ${analysis.warning ? badge("warning", "warn") : ""}
    </div>
    <div class="fact-grid">
      ${summary.filter(([, value]) => value).map(([name, value]) => `
        <div>
          <span>${escapeHtml(name)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join("")}
    </div>
    ${analysis.warning ? `<p class="inline-message warn">${escapeHtml(analysis.warning)}</p>` : ""}
    <pre>${escapeHtml(jsonText(data))}</pre>
  `;
}

function renderHistoryPane(revisions) {
  if (!revisions.length) {
    $("panel-history").innerHTML = `<div class="list-empty">No revisions yet.</div>`;
    return;
  }
  $("panel-history").innerHTML = revisions.map((revision) => `
    <details class="revision-item">
      <summary>${escapeHtml(revision.locale)} · ${escapeHtml(revision.revisionSource)} · ${new Date(revision.createdAt).toLocaleString()}</summary>
      ${revision.instruction ? `<p class="revision-instruction">${escapeHtml(revision.instruction)}</p>` : ""}
      <div class="diff-grid">
        <label><span>Previous</span><textarea readonly>${escapeHtml(revision.previousText || "")}</textarea></label>
        <label><span>Next</span><textarea readonly>${escapeHtml(revision.nextText || "")}</textarea></label>
      </div>
    </details>
  `).join("");
}

async function saveTranslation() {
  if (!selectedDetail) return;
  await api(`/api/translations/${selectedDetail.string.id}/${selectedLocale}`, {
    method: "PUT",
    body: JSON.stringify({ text: $("translationText").value }),
  });
  toast("Translation saved", "good");
  await loadDetail(selectedDetail.string.id);
}

// P-06: approve the CURRENT translation text as-is (per locale per entry).
async function approveTranslation() {
  if (!selectedDetail) return;
  await api(`/api/translations/${selectedDetail.string.id}/${selectedLocale}/approve`, { method: "POST" });
  toast("Translation approved", "good");
  await loadDetail(selectedDetail.string.id);
}

// P-06: reject with a required note — rejected machine translations are
// regenerated by the next translate run with the note in the prompt context.
async function rejectTranslation() {
  if (!selectedDetail) return;
  const note = window.prompt("Rejection note (sent to the translator / regeneration prompt):", "");
  if (note === null) return;
  if (!note.trim()) {
    toast("A rejection note is required", "bad");
    return;
  }
  await api(`/api/translations/${selectedDetail.string.id}/${selectedLocale}/reject`, {
    method: "POST",
    body: JSON.stringify({ note: note.trim() }),
  });
  toast("Translation rejected", "good");
  await loadDetail(selectedDetail.string.id);
}

async function reviseWithAi() {
  if (!selectedDetail) return;
  const button = $("reviseTranslation");
  button.disabled = true;
  button.textContent = "Revising with AI...";
  $("revisionResult").hidden = true;
  try {
    const result = await api(`/api/translations/${selectedDetail.string.id}/${selectedLocale}/revise`, {
      method: "POST",
      body: JSON.stringify({ instruction: $("revisionInstruction").value }),
    });
    $("revisionResult").textContent = result.translation?.text || result.message || "Revision complete";
    $("revisionResult").hidden = false;
    await loadDetail(selectedDetail.string.id);
  } catch (err) {
    $("revisionResult").textContent = err.message;
    $("revisionResult").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Revise with AI";
  }
}

async function loadPrompts() {
  const data = await api(projectPath("/api/prompts"));
  promptCache = data.prompts || [];
  renderPrompts();
}

function renderPrompts() {
  if (!promptCache.length) {
    $("promptList").innerHTML = `<div class="list-empty">No prompts stored.</div>`;
    return;
  }
  $("promptList").innerHTML = promptCache.map((prompt) => `
    <article class="editor-row" data-key="${escapeHtml(prompt.key)}">
      <div class="row-head">
        <div>
          <strong>${escapeHtml(prompt.key)}</strong>
          <span>${escapeHtml(prompt.updatedAt ? new Date(prompt.updatedAt).toLocaleString() : "")}</span>
        </div>
        ${badge(prompt.active ? "active" : "inactive", prompt.active ? "good" : "neutral")}
      </div>
      <input class="prompt-label" value="${escapeHtml(prompt.label)}">
      <textarea class="prompt-body" spellcheck="false">${escapeHtml(prompt.body)}</textarea>
      <div class="actions">
        <button class="primary prompt-save" type="button">Save prompt</button>
      </div>
    </article>
  `).join("");
}

async function savePrompt(row) {
  const key = row.dataset.key;
  await api(projectPath(`/api/prompts/${encodeURIComponent(key)}`), {
    method: "PUT",
    body: JSON.stringify({
      label: row.querySelector(".prompt-label").value,
      body: row.querySelector(".prompt-body").value,
    }),
  });
  toast("Prompt saved", "good");
  await loadPrompts();
}

async function createPrompt(event) {
  event.preventDefault();
  const key = $("promptKey").value.trim();
  if (!key) return;
  await api(projectPath(`/api/prompts/${encodeURIComponent(key)}`), {
    method: "PUT",
    body: JSON.stringify({
      label: $("promptLabel").value.trim() || key,
      body: "",
    }),
  });
  $("promptKey").value = "";
  $("promptLabel").value = "";
  toast("Prompt added", "good");
  await loadPrompts();
}

async function loadGlossary() {
  const data = await api(projectPath("/api/glossary"));
  glossaryCache = data.terms || [];
  renderGlossary();
}

function renderGlossary() {
  if (!glossaryCache.length) {
    $("glossaryList").innerHTML = `<div class="list-empty">No glossary terms stored.</div>`;
    return;
  }
  $("glossaryList").innerHTML = `
    <div class="table-head glossary-grid">
      <span>Term</span><span>Locale</span><span>Translation</span><span>Description</span><span>DNT</span><span></span>
    </div>
    ${glossaryCache.map((term) => `
      <form class="table-row glossary-grid" data-id="${escapeHtml(term.id)}">
        <input class="term" value="${escapeHtml(term.term)}" required>
        <input class="locale" value="${escapeHtml(term.locale || "")}">
        <input class="translation" value="${escapeHtml(term.translation || "")}">
        <input class="description" value="${escapeHtml(term.description || "")}">
        <label class="check-field compact"><input class="dnt" type="checkbox" ${term.doNotTranslate ? "checked" : ""}><span>DNT</span></label>
        <div class="row-actions">
          <button class="glossary-save" type="submit">Save</button>
          <button class="danger glossary-delete" type="button">Delete</button>
        </div>
      </form>
    `).join("")}
  `;
}

function glossaryPayload(scope) {
  return {
    term: scope.querySelector(".term")?.value ?? $("glossaryTerm").value,
    locale: scope.querySelector(".locale")?.value ?? selectedLocale,
    translation: scope.querySelector(".translation")?.value ?? $("glossaryTranslation").value,
    description: scope.querySelector(".description")?.value ?? $("glossaryDescription").value,
    doNotTranslate: scope.querySelector(".dnt")?.checked ?? $("glossaryDnt").checked,
  };
}

async function createGlossary(event) {
  event.preventDefault();
  await api(projectPath("/api/glossary"), {
    method: "POST",
    body: JSON.stringify({
      term: $("glossaryTerm").value,
      locale: selectedLocale,
      translation: $("glossaryTranslation").value,
      description: $("glossaryDescription").value,
      doNotTranslate: $("glossaryDnt").checked,
    }),
  });
  event.target.reset();
  toast("Glossary term added", "good");
  await loadGlossary();
}

async function saveGlossary(row) {
  await api(projectPath(`/api/glossary/${row.dataset.id}`), {
    method: "PUT",
    body: JSON.stringify(glossaryPayload(row)),
  });
  toast("Glossary term saved", "good");
  await loadGlossary();
}

async function deleteGlossary(row) {
  await api(projectPath(`/api/glossary/${row.dataset.id}`), { method: "DELETE" });
  toast("Glossary term deleted", "good");
  await loadGlossary();
}

async function loadPersonas() {
  const data = await api(projectPath("/api/personas"));
  personaCache = data.personas || [];
  renderPersona();
}

function currentPersona() {
  const locale = $("personaLocale").value || selectedLocale;
  return personaCache.find((persona) => persona.locale === locale) || {
    locale,
    active: true,
    body: {
      locale,
      developer_persona: "",
      relationship: "",
      sentence_rhythm: "",
      humor_sources: [],
      internet_language_policy: "",
      never_rules: [],
    },
  };
}

function renderPersona() {
  const persona = currentPersona();
  $("personaActive").checked = persona.active !== false;
  $("personaBody").value = jsonText(persona.body);
  $("personaMessage").hidden = true;
}

function formatPersona() {
  try {
    $("personaBody").value = jsonText(JSON.parse($("personaBody").value));
    $("personaMessage").hidden = true;
  } catch (err) {
    $("personaMessage").textContent = err.message;
    $("personaMessage").hidden = false;
  }
}

async function savePersona() {
  let body;
  try {
    body = JSON.parse($("personaBody").value);
  } catch (err) {
    $("personaMessage").textContent = err.message;
    $("personaMessage").hidden = false;
    return;
  }
  const locale = $("personaLocale").value;
  await api(projectPath(`/api/personas/${encodeURIComponent(locale)}`), {
    method: "PUT",
    body: JSON.stringify({ body, active: $("personaActive").checked }),
  });
  toast("Persona saved", "good");
  await loadPersonas();
}

function activateView(view, { manual = false, adminSection, fromHistory = false, load = true } = {}) {
  if (!canVisitView(view)) view = "home";
  const sameAdministration = view === "access" && selectedView === "access"
    && accessState?.organization?.id === $("accessOrganization").value;
  if (view === "access" && selectedView !== "access" && manual) {
    const organizationId = window.HedgelingShell?.organizationContext();
    if (accessOrganizations.some((o) => o.id === organizationId)) $("accessOrganization").value = organizationId;
  }
  selectedView = view;
  window.HedgelingShell?.setRoute(view, adminSection, manual, fromHistory);
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });
  syncConsoleShell();
  if (manual) {
    document.dispatchEvent(new CustomEvent("hedgeling:manual-navigation"));
    $("consoleMain").focus({ preventScroll: true });
  }
  if (!load) return;
  if (view === "workspace" && manual) window.HedgelingAgent?.showProjects().catch((err) => toast(err.message, "bad"));
  if (view === "prompts") loadPrompts().catch((err) => toast(err.message, "bad"));
  if (view === "glossary") loadGlossary().catch((err) => toast(err.message, "bad"));
  if (view === "personas") loadPersonas().catch((err) => toast(err.message, "bad"));
  if (view === "review") loadStrings().catch((err) => toast(err.message, "bad"));
  if (view === "work") loadPersonalWork().catch((err) => toast(err.message, "bad"));
  if (view === "access" && !sameAdministration) loadAccess().catch((err) => toast(err.message, "bad"));
}

function bindEvents() {
  $("signOut").addEventListener("click", () => signOut().catch((err) => toast(err.message, "bad")));
  $("project").addEventListener("change", async () => {
    selectedProjectSlug = $("project").value;
    localStorage.setItem("hedgeling.console.project", selectedProjectSlug);
    selectedStringId = null;
    selectedDetail = null;
    $("detail").hidden = true;
    $("emptyState").hidden = false;
    await loadProject();
    const loaders = [loadStrings()];
    if (hasProjectPermission("prompts.view")) loaders.push(loadPrompts());
    if (hasProjectPermission("glossary.view")) loaders.push(loadGlossary());
    if (hasProjectPermission("personas.view")) loaders.push(loadPersonas());
    await Promise.all(loaders);
  });
  $("locale").addEventListener("change", async () => {
    selectedLocale = $("locale").value;
    const permissionData = await api(`/api/projects/${encodeURIComponent(selectedProjectSlug)}/permissions?locale=${encodeURIComponent(selectedLocale)}`);
    projectPermissionSet = new Set(permissionData.permissions || []);
    applyPermissionVisibility();
    populateSelect($("personaLocale"), locales, selectedLocale);
    await loadStrings();
    if (selectedStringId) await loadDetail(selectedStringId);
    if (selectedView === "personas") renderPersona();
  });
  $("personaLocale").addEventListener("change", renderPersona);
  $("search").addEventListener("input", debounce(() => loadStrings().catch((err) => toast(err.message, "bad"))));
  $("status").addEventListener("change", () => loadStrings().catch((err) => toast(err.message, "bad")));
  $("sourceFacet").addEventListener("change", () => {
    selectedSourceFacet = $("sourceFacet").value;
    loadStrings().catch((err) => toast(err.message, "bad"));
  });
  $("enumGrids").addEventListener("click", (event) => {
    const button = event.target.closest(".enum-verify-all");
    if (!button) return;
    bulkVerifyEnumField(Number(button.dataset.fieldIndex)).catch((err) => toast(err.message, "bad"));
  });
  $("translationText").addEventListener("input", updateCharBudget);
  $("translationText").addEventListener("input", updateChipPreviews);
  $("saveTranslation").addEventListener("click", () => saveTranslation().catch((err) => toast(err.message, "bad")));
  $("approveTranslation").addEventListener("click", () => approveTranslation().catch((err) => toast(err.message, "bad")));
  $("rejectTranslation").addEventListener("click", () => rejectTranslation().catch((err) => toast(err.message, "bad")));
  $("reloadDetail").addEventListener("click", () => loadDetail().catch((err) => toast(err.message, "bad")));
  $("reviseTranslation").addEventListener("click", () => reviseWithAi().catch((err) => toast(err.message, "bad")));
  $("promptCreate").addEventListener("submit", (event) => createPrompt(event).catch((err) => toast(err.message, "bad")));
  $("glossaryCreate").addEventListener("submit", (event) => createGlossary(event).catch((err) => toast(err.message, "bad")));
  $("formatPersona").addEventListener("click", formatPersona);
  $("savePersona").addEventListener("click", () => savePersona().catch((err) => toast(err.message, "bad")));
  $("accessOrganization").addEventListener("change", () => {
    $("vendorInviteResult").hidden = true;
    $("vendorInviteResult").textContent = "";
    refreshAccess().catch((err) => toast(err.message, "bad"));
  });
  $("businessUnitCreate").addEventListener("submit", (event) => createBusinessUnit(event).catch((err) => toast(err.message, "bad")));
  $("memberInvite").addEventListener("submit", (event) => inviteMember(event).catch((err) => toast(err.message, "bad")));
  $("teamCreate").addEventListener("submit", (event) => createTeam(event).catch((err) => toast(err.message, "bad")));
  $("roleAssignmentCreate").addEventListener("submit", (event) => createRoleAssignment(event).catch((err) => toast(err.message, "bad")));
  $("identityPolicyForm").addEventListener("submit", (event) => saveIdentityPolicy(event).catch((err) => toast(err.message, "bad")));
  $("identityDomainForm").addEventListener("submit", (event) => claimIdentityDomain(event).catch((err) => toast(err.message, "bad")));
  $("identityConnectionForm").addEventListener("submit", (event) => createIdentityConnection(event).catch((err) => toast(err.message, "bad")));
  $("identityRecoveryForm").addEventListener("submit", (event) => createIdentityRecovery(event).catch((err) => toast(err.message, "bad")));
  $("serviceAccountForm").addEventListener("submit", (event) => createServiceAccount(event).catch((err) => toast(err.message, "bad")));
  $("scimTokenForm").addEventListener("submit", (event) => createScimToken(event).catch((err) => toast(err.message, "bad")));
  $("accessReviewForm").addEventListener("submit", (event) => createAccessReview(event).catch((err) => toast(err.message, "bad")));
  $("vendorCreate").addEventListener("submit", (event) => createVendorRelationship(event).catch((err) => toast(err.message, "bad")));
  $("paymentProgramForm").addEventListener("submit", (event) => savePaymentProgram(event).catch((err) => toast(err.message, "bad")));
  $("payoutOnboarding").addEventListener("click", () => startPayoutOnboarding().catch((err) => toast(err.message, "bad")));
  $("payoutRefresh").addEventListener("click", () => refreshPayoutAccount().catch((err) => toast(err.message, "bad")));
  $("payoutDashboard").addEventListener("click", () => openPayoutDashboard().catch((err) => toast(err.message, "bad")));
  $("reconcileFacilitatedPayments").addEventListener("click", () => (
    reconcileFacilitatedPayments().catch((err) => toast(err.message, "bad"))
  ));
  $("assignmentPrincipalType").addEventListener("change", updateAssignmentPrincipals);
  $("assignmentScopeType").addEventListener("change", updateAssignmentScopes);
  $("budgetScopeType").addEventListener("change", updateBudgetScopes);
  $("budgetCreate").addEventListener("submit", (event) => createBudget(event).catch((err) => toast(err.message, "bad")));
  $("businessUnitList").addEventListener("submit", (event) => {
    event.preventDefault();
    const row = event.target;
    api(accessPath(`/business-units/${encodeURIComponent(row.dataset.id)}`), {
      method: "PATCH",
      body: JSON.stringify({ name: row.elements.name.value, status: row.elements.status.value }),
    }).then(refreshAccess).then(() => toast("Business unit updated", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("memberList").addEventListener("submit", (event) => {
    event.preventDefault();
    const row = event.target;
    api(accessPath(`/members/${encodeURIComponent(row.dataset.id)}`), {
      method: "PATCH",
      body: JSON.stringify({
        membershipType: row.elements.membershipType.value,
        status: row.elements.status.value,
        expiresAt: row.elements.expiresAt.value ? new Date(row.elements.expiresAt.value).toISOString() : null,
      }),
    }).then(refreshAccess).then(() => toast("Member updated", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("teamList").addEventListener("submit", (event) => {
    event.preventDefault();
    const row = event.target;
    const membershipIds = [...row.elements.membershipIds.selectedOptions].map((option) => option.value);
    api(accessPath(`/teams/${encodeURIComponent(row.dataset.id)}/members`), {
      method: "PUT",
      body: JSON.stringify({ membershipIds }),
    }).then(refreshAccess).then(() => toast("Team updated", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("assignmentList").addEventListener("click", (event) => {
    const button = event.target.closest(".assignment-revoke");
    if (!button) return;
    api(accessPath(`/role-assignments/${encodeURIComponent(button.dataset.id)}`), { method: "DELETE" })
      .then(refreshAccess).then(() => toast("Role revoked", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("identityDomainList").addEventListener("click", (event) => {
    const button = event.target.closest(".identity-domain-verify");
    if (!button) return;
    api(accessPath(`/identity/domains/${encodeURIComponent(button.dataset.id)}/verify`), { method: "POST" })
      .then(loadEnterpriseAccess).then(() => toast("Domain verified", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("identityConnectionList").addEventListener("click", (event) => {
    const button = event.target.closest(".identity-connection-toggle");
    if (!button) return;
    api(accessPath(`/identity/connections/${encodeURIComponent(button.dataset.id)}`), {
      method: "PATCH",
      body: JSON.stringify({ status: button.dataset.status }),
    }).then(loadEnterpriseAccess).then(() => toast("Identity connection updated", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("identityRecoveryList").addEventListener("click", (event) => {
    const button = event.target.closest(".identity-recovery-revoke");
    if (!button) return;
    api(accessPath(`/identity/recovery-grants/${encodeURIComponent(button.dataset.id)}`), { method: "DELETE" })
      .then(loadEnterpriseAccess).then(() => toast("Recovery login revoked", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("serviceAccountList").addEventListener("click", (event) => {
    const button = event.target.closest(".service-account-rotate");
    if (!button) return;
    api(accessPath(`/service-accounts/${encodeURIComponent(button.dataset.id)}/credentials`), {
      method: "POST",
      body: JSON.stringify({ revokeExisting: true }),
    }).then((result) => {
      showOneTimeCredential($("serviceCredentialResult"), "Rotated service credential", result.credential.token);
      return loadEnterpriseAccess();
    }).catch((err) => toast(err.message, "bad"));
  });
  $("scimTokenList").addEventListener("click", (event) => {
    const button = event.target.closest(".scim-token-revoke");
    if (!button) return;
    api(accessPath(`/scim-tokens/${encodeURIComponent(button.dataset.id)}`), { method: "DELETE" })
      .then(loadEnterpriseAccess).then(() => toast("SCIM token revoked", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("accessRequestList").addEventListener("click", (event) => {
    const button = event.target.closest(".access-request-decision");
    if (!button) return;
    api(accessPath(`/access-requests/${encodeURIComponent(button.dataset.id)}`), {
      method: "PATCH",
      body: JSON.stringify({ decision: button.dataset.decision }),
    }).then(loadEnterpriseAccess).then(() => toast(`Access request ${button.dataset.decision}`, "good")).catch((err) => toast(err.message, "bad"));
  });
  $("accessReviewList").addEventListener("click", (event) => {
    const loadButton = event.target.closest(".access-review-load");
    if (loadButton) {
      loadAccessReviewItems(loadButton.dataset.id).catch((err) => toast(err.message, "bad"));
      return;
    }
    const transitionButton = event.target.closest(".access-review-transition");
    if (!transitionButton) return;
    api(accessPath(`/access-reviews/${encodeURIComponent(transitionButton.dataset.id)}`), {
      method: "PATCH",
      body: JSON.stringify({ transition: transitionButton.dataset.transition }),
    }).then(loadEnterpriseAccess).then(() => toast("Access review updated", "good")).catch((err) => toast(err.message, "bad"));
  });
  $("accessReviewItemList").addEventListener("click", (event) => {
    const button = event.target.closest(".access-review-decision");
    if (!button || !selectedAccessReviewId) return;
    api(accessPath(`/access-reviews/${encodeURIComponent(selectedAccessReviewId)}/items/${encodeURIComponent(button.dataset.id)}`), {
      method: "PATCH",
      body: JSON.stringify({ decision: button.dataset.decision }),
    }).then(() => Promise.all([
      loadAccessReviewItems(selectedAccessReviewId),
      loadEnterpriseAccess(),
    ])).catch((err) => toast(err.message, "bad"));
  });
  $("vendorRelationshipList").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    const relationshipId = form.closest(".vendor-relationship")?.dataset.id;
    if (!relationshipId) return;
    if (form.classList.contains("vendor-settings-form")) {
      saveVendorSettings(form, relationshipId).catch((err) => toast(err.message, "bad"));
    } else if (form.classList.contains("vendor-scopes-form")) {
      saveVendorScopes(form, relationshipId).catch((err) => toast(err.message, "bad"));
    } else if (form.classList.contains("vendor-nominate-form")) {
      nominateVendorLinguist(form, relationshipId).catch((err) => toast(err.message, "bad"));
    } else if (form.classList.contains("vendor-eligibility-form")) {
      checkVendorEligibility(form, relationshipId).catch((err) => toast(err.message, "bad"));
    } else if (form.classList.contains("rate-card-form")) {
      saveRateCard(form, relationshipId).catch((err) => toast(err.message, "bad"));
    } else if (form.classList.contains("work-order-create-form")) {
      createWorkOrder(form, relationshipId).catch((err) => toast(err.message, "bad"));
    } else {
      const workOrderId = form.closest(".work-order")?.dataset.workOrderId;
      const statementId = form.closest(".payable-statement")?.dataset.statementId;
      if (form.classList.contains("work-assignment-form") && workOrderId) {
        assignWorkOrder(form, relationshipId, workOrderId)
          .catch((err) => toast(err.message, "bad"));
      } else if (form.classList.contains("work-adjustment-form") && workOrderId) {
        recordWorkAdjustment(form, relationshipId, workOrderId)
          .catch((err) => toast(err.message, "bad"));
      } else if (form.classList.contains("work-dispute-form") && workOrderId) {
        openWorkDispute(form, relationshipId, workOrderId)
          .catch((err) => toast(err.message, "bad"));
      } else if (form.classList.contains("statement-create-form")) {
        createPayableStatement(form, relationshipId)
          .catch((err) => toast(err.message, "bad"));
      } else if (form.classList.contains("payment-record-form") && statementId) {
        recordStatementPayment(form, relationshipId, statementId)
          .catch((err) => toast(err.message, "bad"));
      } else if (form.classList.contains("facilitated-refund-form") && statementId) {
        requestFacilitatedRefund(form, relationshipId, statementId)
          .catch((err) => toast(err.message, "bad"));
      }
    }
  });
  $("vendorRelationshipList").addEventListener("click", (event) => {
    const relationship = event.target.closest(".vendor-relationship");
    if (!relationship) return;
    const workOrder = event.target.closest(".work-order");
    const workTransition = event.target.closest(".work-transition");
    if (workOrder && workTransition) {
      transitionWorkOrder(
        relationship.dataset.id,
        workOrder.dataset.workOrderId,
        workTransition.dataset.action,
      ).catch((err) => toast(err.message, "bad"));
      return;
    }
    const assignmentRevoke = event.target.closest(".work-assignment-revoke");
    if (workOrder && assignmentRevoke) {
      revokeWorkAssignment(
        relationship.dataset.id,
        workOrder.dataset.workOrderId,
        assignmentRevoke.dataset.assignmentId,
      ).catch((err) => toast(err.message, "bad"));
      return;
    }
    const disputeResolve = event.target.closest(".work-dispute-resolve");
    if (workOrder && disputeResolve) {
      resolveWorkDispute(
        relationship.dataset.id,
        workOrder.dataset.workOrderId,
        disputeResolve.dataset.disputeId,
      ).catch((err) => toast(err.message, "bad"));
      return;
    }
    const statement = event.target.closest(".payable-statement");
    const checkoutResume = event.target.closest(".statement-checkout-resume");
    if (statement && checkoutResume) {
      window.location.assign(checkoutResume.dataset.checkoutUrl);
      return;
    }
    const statementPay = event.target.closest(".statement-pay");
    if (statement && statementPay) {
      startFacilitatedStatementPayment(
        relationship.dataset.id,
        statement.dataset.statementId,
      ).catch((err) => toast(err.message, "bad"));
      return;
    }
    const statementTransition = event.target.closest(".statement-transition");
    if (statement && statementTransition) {
      transitionPayableStatement(
        relationship.dataset.id,
        statement.dataset.statementId,
        statementTransition.dataset.action,
      ).catch((err) => toast(err.message, "bad"));
      return;
    }
    const paymentDecision = event.target.closest(".payment-decision");
    const payment = paymentDecision?.closest(".payment-row");
    if (statement && paymentDecision && payment) {
      decideStatementPayment(
        relationship.dataset.id,
        statement.dataset.statementId,
        payment.dataset.paymentId,
        paymentDecision.dataset.status,
      ).catch((err) => toast(err.message, "bad"));
      return;
    }
    const rateCardCreate = event.target.closest(".rate-card-create-toggle");
    if (rateCardCreate) {
      const editor = relationship.querySelector(".rate-card-create-editor");
      if (editor) editor.open = true;
      return;
    }
    const addRateLine = event.target.closest(".rate-line-add");
    if (addRateLine) {
      const detail = vendorRelationshipState.find(
        (item) => item.vendorRelationship.id === relationship.dataset.id,
      );
      addRateLine.closest(".rate-card-form")?.querySelector(".rate-line-list")
        ?.insertAdjacentHTML("beforeend", rateCardLineRow(detail));
      return;
    }
    const removeRateLine = event.target.closest(".rate-line-remove");
    if (removeRateLine) {
      const list = removeRateLine.closest(".rate-line-list");
      if (list?.querySelectorAll(".rate-line-row").length === 1) {
        toast("A draft needs at least one editable rate line", "bad");
        return;
      }
      removeRateLine.closest(".rate-line-row")?.remove();
      return;
    }
    const rateCardTransition = event.target.closest(".rate-card-transition");
    const rateCard = rateCardTransition?.closest(".rate-card");
    if (rateCardTransition && rateCard) {
      transitionRateCard(
        relationship.dataset.id,
        rateCard.dataset.rateCardId,
        rateCardTransition.dataset.status,
      ).catch((err) => toast(err.message, "bad"));
      return;
    }
    const transition = event.target.closest(".vendor-transition");
    if (transition) {
      transitionVendorRelationship(relationship.dataset.id, transition.dataset.status)
        .catch((err) => toast(err.message, "bad"));
      return;
    }
    const linguistAction = event.target.closest(".vendor-linguist-action");
    const linguistRow = linguistAction?.closest(".vendor-linguist-row");
    if (linguistAction && linguistRow) {
      updateVendorLinguist(
        relationship.dataset.id,
        linguistRow.dataset.linguistId,
        linguistAction.dataset.status,
      ).catch((err) => toast(err.message, "bad"));
    }
  });
  $("vendorRelationshipList").addEventListener("change", (event) => {
    if (event.target.name !== "projectId") return;
    const businessUnitId = event.target.selectedOptions[0]?.dataset.businessUnitId;
    if (businessUnitId) {
      event.target.closest(".rate-line-row")
        ?.querySelector('[name="businessUnitId"]')
        ?.setAttribute("value", businessUnitId);
      const businessUnitSelect = event.target.closest(".rate-line-row")
        ?.querySelector('[name="businessUnitId"]');
      if (businessUnitSelect) businessUnitSelect.value = businessUnitId;
    }
  });
  $("budgetList").addEventListener("click", (event) => {
    const button = event.target.closest(".budget-remove");
    if (!button || !window.confirm("Remove this usage budget? Historical alerts will be retained.")) return;
    api(accessPath(`/budgets/${encodeURIComponent(button.dataset.id)}`), { method: "DELETE" })
      .then(() => Promise.all([loadUsageAndBudgets(), loadAudit()]))
      .then(() => toast("Usage budget removed", "good"))
      .catch((err) => toast(err.message, "bad"));
  });
  $("budgetAlertList").addEventListener("click", (event) => {
    const button = event.target.closest(".budget-alert-ack");
    if (!button) return;
    api(accessPath(`/budget-alerts/${encodeURIComponent(button.dataset.id)}/acknowledge`), { method: "POST" })
      .then(() => Promise.all([loadUsageAndBudgets(), loadAudit()]))
      .then(() => toast("Budget alert acknowledged", "good"))
      .catch((err) => toast(err.message, "bad"));
  });
  $("personalWorkList").addEventListener("click", (event) => {
    const assignment = event.target.closest(".personal-assignment");
    if (!assignment) return;
    openPersonalWorkAssignment(assignment.dataset.assignmentId)
      .catch((err) => toast(err.message, "bad"));
  });
  $("personalWorkDetail").addEventListener("click", (event) => {
    if (event.target.closest("#personalWorkStart")) {
      startPersonalWork().catch((err) => toast(err.message, "bad"));
      return;
    }
    const save = event.target.closest(".personal-translation-save");
    const item = save?.closest(".personal-work-item");
    if (!save || !item) return;
    savePersonalTranslation(
      item.dataset.sourceStringId,
      item.querySelector('[name="translationText"]').value,
    ).catch((err) => toast(err.message, "bad"));
  });
  $("personalWorkDetail").addEventListener("submit", (event) => {
    if (event.target.id !== "personalWorkSubmit") return;
    event.preventDefault();
    submitPersonalWork(event.target).catch((err) => toast(err.message, "bad"));
  });

  $("stringList").addEventListener("click", (event) => {
    const button = event.target.closest(".string-item");
    if (button) loadDetail(button.dataset.id).catch((err) => toast(err.message, "bad"));
  });
  document.querySelector(".subtabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-panel]");
    if (!button) return;
    document.querySelectorAll(".subtabs button").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".inspect-pane").forEach((pane) => pane.classList.toggle("active", pane.id === `panel-${button.dataset.panel}`));
  });
  $("promptList").addEventListener("click", (event) => {
    const button = event.target.closest(".prompt-save");
    if (button) savePrompt(button.closest(".editor-row")).catch((err) => toast(err.message, "bad"));
  });
  $("glossaryList").addEventListener("submit", (event) => {
    event.preventDefault();
    saveGlossary(event.target).catch((err) => toast(err.message, "bad"));
  });
  $("glossaryList").addEventListener("click", (event) => {
    const button = event.target.closest(".glossary-delete");
    if (button) deleteGlossary(button.closest(".table-row")).catch((err) => toast(err.message, "bad"));
  });
}

async function init() {
  bindEvents();
  handleVendorPaymentCallback();
  currentAuth = (await api("/api/me")).auth;
  $("paymentOperationsLink").hidden = !canViewPlatformPayments();
  await acceptInvitationFromUrl();
  await loadAccessOrganizations();
  const hasProject = await loadProject();
  const loaders = [loadPersonalWork()];
  if (hasProject && hasProjectPermission("strings.view")) loaders.push(loadStrings());
  await Promise.all(loaders);
  const target = window.HedgelingShell?.route();
  const landing = personalWorkState.length && !accessOrganizations.length ? "work" : "home";
  activateView(target?.view || landing, { adminSection: target?.adminSection });
  await handleConnectCallback();
}

init().catch((err) => toast(err.message, "bad"));

// The agent addresses semantic destinations; it never supplies selectors or JS.
window.HedgelingConsole = {
  openWorkspace() { activateView("workspace"); },
  navigate: activateView,
  notify(message) { toast(message, "bad"); },
  async openOrganization(id) {
    if (!accessOrganizations.some((o) => o.id === id)) throw new Error("Organization is not accessible");
    $("accessOrganization").value = id;
    activateView("access", { manual: true, load: false });
    await loadAccess();
  },
  async openAssignment(id) { activateView("work", { manual: true, load: false }); await openPersonalWorkAssignment(id); },
  async openProject(slug, options = {}) {
    if (options.manual) document.dispatchEvent(new CustomEvent("hedgeling:manual-navigation"));
    const visible = (await api("/api/projects")).projects;
    if (!visible.some((project) => project.slug === slug)) throw new Error("Project is not accessible");
    selectedProjectSlug = slug;
    localStorage.setItem("hedgeling.console.project", slug);
    await loadProject();
    selectedStringId = null; selectedDetail = null;
    $("detail").hidden = true; $("emptyState").hidden = false;
    activateView(hasProjectPermission("strings.view") ? "review" : "library", { ...options, load: false });
    if (hasProjectPermission("strings.view")) await loadStrings();
  },
  async refresh() { await loadAccessOrganizations(); await loadProject(); },
};
