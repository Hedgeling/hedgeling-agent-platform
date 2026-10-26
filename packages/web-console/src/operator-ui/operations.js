const $ = (id) => document.getElementById(id);

let auth = null;
let canManage = false;
let events = [];
let checkpoints = [];
let exceptions = [];
let recoveryCases = [];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[character]);
}

function statusTone(status) {
  if (["processed", "succeeded", "idle", "resolved", "passed"].includes(status)) return "good";
  if (["failed", "critical", "written_off"].includes(status)) return "bad";
  if (["processing", "partial", "running", "open", "high"].includes(status)) return "warn";
  return "neutral";
}

function badge(value, tone = statusTone(value)) {
  return `<span class="badge ${escapeHtml(tone)}">${escapeHtml(value || "unknown")}</span>`;
}

function dateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Invalid timestamp" : date.toLocaleString();
}

function toast(message, tone = "neutral") {
  const node = $("toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4200);
}

async function api(path, options = {}) {
  let response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 401) {
    const refreshed = await fetch("/api/auth/refresh", { method: "POST" });
    if (refreshed.ok) {
      response = await fetch(path, {
        headers: { "content-type": "application/json", ...(options.headers || {}) },
        ...options,
      });
    } else {
      location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
      throw new Error("Your session has expired");
    }
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || response.statusText);
    error.code = body.code || null;
    error.details = body.details || null;
    throw error;
  }
  return body;
}

function loading(node, label) {
  node.innerHTML = `<div class="loading">${escapeHtml(label)}</div>`;
}

function errorState(node, error, retryName) {
  node.innerHTML = `
    <div class="error-state">
      <strong>${escapeHtml(error.message)}</strong>
      <small>${escapeHtml(error.code || "request_failed")}</small>
      <button type="button" data-retry="${escapeHtml(retryName)}">Retry</button>
    </div>
  `;
}

function summaryItem(label, value, tone = "neutral") {
  return `<div class="summary-item"><span>${escapeHtml(label)}</span><strong class="${escapeHtml(tone)}">${escapeHtml(value)}</strong></div>`;
}

function renderSummary(data) {
  const counts = data.counts || {};
  const certification = data.certification || {};
  $("operationsSummary").innerHTML = [
    summaryItem("Active payments", counts.activeAttempts ?? 0),
    summaryItem("Transfer queue", counts.transferQueue ?? 0),
    summaryItem("Refund queue", counts.refundQueue ?? 0),
    summaryItem("Payouts in flight", counts.nonterminalPayouts ?? 0),
    summaryItem("Failed events", counts.failedProviderEvents ?? 0, counts.failedProviderEvents ? "bad" : "good"),
    summaryItem("Open exceptions", counts.openExceptions ?? 0, counts.openExceptions ? "bad" : "good"),
    summaryItem("Recovery cases", counts.openRecoveryCases ?? 0, counts.openRecoveryCases ? "warn" : "good"),
    summaryItem(
      "Payout scans stale",
      counts.stalePayoutReconciliations ?? 0,
      counts.stalePayoutReconciliations ? "bad" : "good",
    ),
    summaryItem(
      "Certification",
      certification.ready ? "Passed" : `${certification.missing?.length || 0} remaining`,
      certification.ready ? "good" : "warn",
    ),
  ].join("");
}

function eventQuery() {
  const form = new FormData($("eventFilters"));
  const params = new URLSearchParams();
  for (const [key, rawValue] of form.entries()) {
    const value = String(rawValue).trim();
    if (!value) continue;
    if (["receivedFrom", "receivedTo"].includes(key)) {
      params.set(key, new Date(value).toISOString());
    } else {
      params.set(key, value);
    }
  }
  return params.toString();
}

function renderEvents() {
  const node = $("eventQueue");
  if (!events.length) {
    node.innerHTML = '<div class="empty">No provider events match these filters.</div>';
    return;
  }
  node.innerHTML = events.map((event) => `
    <article class="data-row" data-event-id="${escapeHtml(event.providerEventId)}">
      <div>
        <strong>${escapeHtml(event.eventType)}</strong>
        <code>${escapeHtml(event.providerEventId)}</code>
        <small>Received ${escapeHtml(dateTime(event.receivedAt))}</small>
      </div>
      <div class="badge-group">
        ${badge(event.status)}
        ${event.replayStatus !== "not_requested" ? badge(`replay ${event.replayStatus}`) : ""}
        ${badge(event.livemode ? "live" : "test", event.livemode ? "warn" : "neutral")}
        ${badge(event.domain)}
      </div>
      <div>
        <strong>${escapeHtml(event.targetResourceType || "No linked resource")}</strong>
        <code>${escapeHtml(event.targetResourceId || event.connectedAccountContext || "—")}</code>
        <small>${event.lastError
          ? `<span class="row-error">${escapeHtml(event.lastError)}</span>`
          : `Processed ${escapeHtml(dateTime(event.processedAt))}`}</small>
        <small>${escapeHtml(event.attempts)} processing attempt(s)</small>
      </div>
      <div class="actions">
        ${canManage && event.status === "failed"
          ? `<button class="event-replay danger" type="button" data-event-id="${escapeHtml(event.providerEventId)}">Replay</button>`
          : ""}
      </div>
    </article>
  `).join("");
}

async function loadEvents() {
  loading($("eventQueue"), "Loading provider events…");
  try {
    const query = eventQuery();
    const data = await api(`/api/platform/facilitated-payments/provider-events${query ? `?${query}` : ""}`);
    events = data.events || [];
    renderEvents();
  } catch (error) {
    errorState($("eventQueue"), error, "events");
  }
}

function renderCheckpoints(maximumLagMinutes) {
  const node = $("payoutCheckpoints");
  if (!checkpoints.length) {
    node.innerHTML = '<div class="empty">No connected payout accounts have reconciliation checkpoints yet.</div>';
    return;
  }
  node.innerHTML = checkpoints.map((checkpoint) => `
    <article class="data-row" data-account-id="${escapeHtml(checkpoint.connectedAccountId)}">
      <div>
        <strong>Stripe account ${escapeHtml(checkpoint.providerAccountId)}</strong>
        <code>${escapeHtml(checkpoint.connectedAccountId)}</code>
        <small>Agency ${escapeHtml(checkpoint.agencyOrganizationId)}</small>
      </div>
      <div class="badge-group">
        ${badge(checkpoint.scanStatus)}
        ${badge(checkpoint.providerMode, checkpoint.providerMode === "live" ? "warn" : "neutral")}
        ${checkpoint.stale ? badge("stale", "bad") : badge("fresh", "good")}
      </div>
      <div>
        <strong>Last successful: ${escapeHtml(dateTime(checkpoint.lastSuccessfulScanAt))}</strong>
        <small>Freshness target: ${escapeHtml(maximumLagMinutes)} minutes</small>
        <small>${escapeHtml(checkpoint.observedCount)} observed · ${escapeHtml(checkpoint.changedCount)} changed · ${escapeHtml(checkpoint.unchangedCount)} unchanged</small>
        ${checkpoint.lastError ? `<small class="row-error">${escapeHtml(checkpoint.lastError)}</small>` : ""}
      </div>
      <div class="actions">
        ${canManage
          ? `<button class="payout-reconcile" type="button" data-account-id="${escapeHtml(checkpoint.connectedAccountId)}">Scan account</button>`
          : ""}
      </div>
    </article>
  `).join("");
}

async function loadCheckpoints() {
  loading($("payoutCheckpoints"), "Loading payout reconciliation freshness…");
  try {
    const data = await api("/api/platform/facilitated-payments/payout-reconciliation");
    checkpoints = data.checkpoints || [];
    renderCheckpoints(data.maximumLagMinutes);
  } catch (error) {
    errorState($("payoutCheckpoints"), error, "checkpoints");
  }
}

function renderExceptions() {
  $("exceptionQueue").innerHTML = exceptions.length
    ? exceptions.map((exception) => `
      <article class="data-row compact" data-exception-id="${escapeHtml(exception.id)}">
        <div>
          <strong>${escapeHtml(exception.exceptionType)}</strong>
          <code>${escapeHtml(exception.resourceType)} · ${escapeHtml(exception.resourceId)}</code>
          <small>Opened ${escapeHtml(dateTime(exception.createdAt))}</small>
        </div>
        <div class="badge-group">${badge(exception.severity)}${badge(exception.status)}</div>
        <div class="actions">
          ${canManage && exception.status === "open"
            ? `<button class="exception-resolve" type="button" data-exception-id="${escapeHtml(exception.id)}">Resolve</button>`
            : ""}
        </div>
      </article>
    `).join("")
    : '<div class="empty">No payment exceptions.</div>';
  $("recoveryQueue").innerHTML = recoveryCases.length
    ? recoveryCases.map((recovery) => `
      <article class="data-row compact">
        <div>
          <strong>${escapeHtml(recovery.caseType)}</strong>
          <code>${escapeHtml(recovery.id)}</code>
          <small>${escapeHtml(recovery.exposureMinor)} ${escapeHtml(recovery.currency)} minor units exposed</small>
        </div>
        <div class="badge-group">${badge(recovery.status)}</div>
        <div><small>Opened ${escapeHtml(dateTime(recovery.createdAt))}</small></div>
      </article>
    `).join("")
    : '<div class="empty">No recovery cases.</div>';
}

async function loadExceptions() {
  loading($("exceptionQueue"), "Loading exceptions…");
  loading($("recoveryQueue"), "Loading recovery cases…");
  try {
    const [exceptionData, recoveryData] = await Promise.all([
      api("/api/platform/facilitated-payments/exceptions"),
      api("/api/platform/facilitated-payments/recovery-cases"),
    ]);
    exceptions = exceptionData.exceptions || [];
    recoveryCases = recoveryData.recoveryCases || [];
    renderExceptions();
  } catch (error) {
    errorState($("exceptionQueue"), error, "exceptions");
    $("recoveryQueue").innerHTML = "";
  }
}

async function loadSummary() {
  $("operationsSummary").innerHTML = summaryItem("Loading", "…");
  try {
    renderSummary(await api("/api/platform/facilitated-payments/operations"));
  } catch (error) {
    $("operationsSummary").innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAll() {
  await Promise.all([loadSummary(), loadEvents(), loadCheckpoints(), loadExceptions()]);
}

function showResult(label, result) {
  const node = $("reconciliationResult");
  node.textContent = `${label}\n${JSON.stringify(result, null, 2)}`;
  node.hidden = false;
}

async function runAction(button, action) {
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
  }
}

function openReplayDialog(eventId) {
  const event = events.find((candidate) => candidate.providerEventId === eventId);
  $("replayForm").elements.eventId.value = eventId;
  $("replayForm").elements.confirmEventId.value = "";
  $("replayForm").elements.reason.value = "";
  $("replayFailure").textContent = `${eventId}: ${event?.lastError || "failed without a recorded provider error"}`;
  $("replayDialog").showModal();
}

async function replayEvent(form) {
  const eventId = form.elements.eventId.value;
  const correlationId = globalThis.crypto?.randomUUID?.() || `operator-${Date.now()}`;
  const result = await api(
    `/api/platform/facilitated-payments/provider-events/${encodeURIComponent(eventId)}/replay`,
    {
      method: "POST",
      headers: { "x-correlation-id": correlationId },
      body: JSON.stringify({
        reason: form.elements.reason.value,
        confirmEventId: form.elements.confirmEventId.value,
      }),
    },
  );
  $("replayDialog").close();
  showResult("Provider-event replay", result);
  await Promise.all([loadSummary(), loadEvents(), loadExceptions()]);
  toast(`Replayed ${eventId}`, "good");
}

async function resolveException(form) {
  const exceptionId = form.elements.exceptionId.value;
  await api(`/api/platform/facilitated-payments/exceptions/${encodeURIComponent(exceptionId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolution: form.elements.resolution.value }),
  });
  $("resolutionDialog").close();
  await Promise.all([loadSummary(), loadExceptions()]);
  toast("Exception resolved", "good");
}

function bindEvents() {
  $("signOut").addEventListener("click", async () => {
    await fetch("/api/auth/refresh/logout", { method: "POST" });
    location.assign("/login");
  });
  $("refreshAll").addEventListener("click", (event) => runAction(event.currentTarget, loadAll)
    .catch((error) => toast(error.message, "bad")));
  $("eventFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    loadEvents().catch((error) => toast(error.message, "bad"));
  });
  $("clearEventFilters").addEventListener("click", () => {
    $("eventFilters").reset();
    loadEvents().catch((error) => toast(error.message, "bad"));
  });
  $("eventQueue").addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry='events']");
    if (retry) return loadEvents();
    const replay = event.target.closest(".event-replay");
    if (replay) openReplayDialog(replay.dataset.eventId);
    return undefined;
  });
  $("payoutCheckpoints").addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry='checkpoints']");
    if (retry) return loadCheckpoints();
    const reconcile = event.target.closest(".payout-reconcile");
    if (!reconcile) return undefined;
    return runAction(reconcile, async () => {
      const result = await api(
        `/api/platform/facilitated-payments/accounts/${encodeURIComponent(reconcile.dataset.accountId)}/payouts/reconcile`,
        { method: "POST" },
      );
      showResult("Connected-account payout reconciliation", result);
      await Promise.all([loadSummary(), loadCheckpoints(), loadExceptions()]);
      toast("Payout account reconciled", result.status === "succeeded" ? "good" : "neutral");
    }).catch((error) => toast(error.message, "bad"));
  });
  $("exceptionQueue").addEventListener("click", (event) => {
    const retry = event.target.closest("[data-retry='exceptions']");
    if (retry) return loadExceptions();
    const resolve = event.target.closest(".exception-resolve");
    if (!resolve) return undefined;
    $("resolutionForm").elements.exceptionId.value = resolve.dataset.exceptionId;
    $("resolutionForm").elements.resolution.value = "";
    $("resolutionDialog").showModal();
    return undefined;
  });
  $("reconcilePayments").addEventListener("click", (event) => runAction(
    event.currentTarget,
    async () => {
      const result = await api("/api/platform/facilitated-payments/reconcile", { method: "POST" });
      showResult("Open-payment reconciliation", result);
      await Promise.all([loadSummary(), loadEvents(), loadExceptions()]);
    },
  ).catch((error) => toast(error.message, "bad")));
  $("reconcilePayoutFleet").addEventListener("click", (event) => runAction(
    event.currentTarget,
    async () => {
      const result = await api("/api/platform/facilitated-payments/payouts/reconcile", {
        method: "POST",
        body: JSON.stringify({ limit: 25 }),
      });
      showResult("Payout fleet reconciliation", result);
      await Promise.all([loadSummary(), loadCheckpoints(), loadEvents(), loadExceptions()]);
    },
  ).catch((error) => toast(error.message, "bad")));
  $("replayForm").addEventListener("submit", (event) => {
    event.preventDefault();
    replayEvent(event.currentTarget).catch((error) => toast(error.message, "bad"));
  });
  $("resolutionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    resolveException(event.currentTarget).catch((error) => toast(error.message, "bad"));
  });
  document.querySelectorAll("[data-dialog-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
}

async function init() {
  bindEvents();
  auth = (await api("/api/me")).auth;
  canManage = auth?.platformAdmin === true
    || auth?.user?.platformStaff === true
    || auth?.platformOperations?.manage === true;
  $("accessMode").textContent = canManage ? "Manage access" : "Read-only access";
  $("accessMode").className = `badge ${canManage ? "warn" : "neutral"}`;
  $("reconciliationActions").hidden = !canManage;
  await loadAll();
}

init().catch((error) => {
  toast(error.message, "bad");
  $("operationsSummary").innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
});
