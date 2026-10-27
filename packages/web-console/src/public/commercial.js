import { element } from "./agent-components.js";

let generation = 0;
const money = (minor, currency = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(minor) / 100);
const number = (value) => value == null ? "—" : /^\d+$/.test(String(value)) ? BigInt(value).toLocaleString() : String(value);
const date = (value) => value ? new Date(value).toLocaleDateString() : "—";
async function api(path, body, method = "POST") {
  const response = await fetch(path, { method: body === undefined ? "GET" : method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "This change could not be completed");
  return data;
}
function button(text, handler, primary = false) {
  const node = element("button", primary ? "primary" : "", text); node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } catch (error) { window.HedgelingConsole?.notify(error.message); }
    finally { node.disabled = false; }
  });
  return node;
}
function metric(title, value, detail) {
  const card = element("div", "commercial-metric");
  card.append(element("span", "", title), element("strong", "", value), element("p", "", detail)); return card;
}
function confirmation(root, { title, before, after, effect, confirm, cancel, edit }) {
  const card = element("section", "commercial-confirmation"); card.setAttribute("aria-label", title);
  const heading = element("h3", "", title); heading.tabIndex = -1;
  card.append(element("span", "shell-eyebrow", "REVIEW & CONFIRM"), heading);
  const values = element("dl");
  for (const [label, value] of [["Current", before], ["After saving", after]]) values.append(element("dt", "", label), element("dd", "", value));
  card.append(values, element("p", "", effect));
  const error = element("p", "commercial-error"); error.setAttribute("role", "alert");
  const actions = element("div", "commercial-actions");
  const run = async (fn) => {
    for (const control of actions.querySelectorAll("button")) control.disabled = true;
    error.textContent = "";
    try { await fn(); card.remove(); }
    catch (e) { error.textContent = e.message; }
    finally { for (const control of actions.querySelectorAll("button")) control.disabled = false; }
  };
  if (edit) actions.append(button("Edit details", () => run(edit)));
  actions.append(button("Cancel", () => run(cancel)), button("Confirm", () => run(confirm), true));
  card.append(actions, error); root.append(card); heading.focus();
}

async function renderBilling(root, org, permissions, current) {
  const base = `/api/access/organizations/${org}`;
  const [data, catalog] = await Promise.all([api(`${base}/billing-summary`), api("/api/billing/plans")]);
  if (generation !== current) return;
  root.replaceChildren();
  const manage = permissions.includes("billing.manage");
  const heading = element("div", "commercial-heading");
  heading.append(element("div", "", ""));
  heading.firstChild.append(element("p", "shell-eyebrow", "YOUR PLATFORM"), element("h2", "", data.account?.planName || "Choose your plan"));
  heading.append(element("span", "commercial-badge", data.payment.mode === "test" ? "Stripe test mode" : data.account?.subscriptionState?.replaceAll("_", " ") || "Not subscribed"));
  root.append(heading);
  if (data.chat.trialEndsAt) root.append(element("p", "commercial-notice", data.chat.allowed ? `Your no-card trial ends ${date(data.chat.trialEndsAt)}. Upgrade to keep using chat after your trial.` : "Your trial has ended. Upgrade your platform plan to keep chatting."));
  else if (!data.chat.allowed) root.append(element("p", "commercial-notice", data.chat.message));
  const cards = element("div", "commercial-metrics");
  const stringLimits = data.strings.limits.resources || {};
  cards.append(metric("Agent chat", data.chat.allowed ? "Included" : "Plan required", "No per-message charge. Fair-use limits apply. Translation credits stay separate."),
    metric("Managed strings", number(data.strings.current), `Monthly high-water mark: ${number(data.strings.highWater)}${stringLimits.activeSourceStrings ? ` · limit ${number(stringLimits.activeSourceStrings)}` : ""}`),
    metric("Translation credits", number(data.ai.usedCredits), `${number(data.ai.includedCredits)} included this usage period${data.ai.overages ? " · paid overages available" : " · hard stop at your allowance"}`));
  root.append(cards);
  const payments = element("section", "commercial-section");
  payments.append(element("h3", "", "Payment methods & invoices"), element("p", "", "Enter payment details securely with Stripe. Your card number never goes through chat."));
  if (!data.payment.enabled) payments.append(element("p", "commercial-notice", "Checkout is not configured in this environment yet. No payments can be collected."));
  if (manage && data.payment.hasCustomer && data.payment.enabled) payments.append(button("Manage payment methods & invoices ↗", async () => { location.assign((await api(`${base}/billing/portal`, {})).url); }));
  if (!manage) payments.append(element("p", "", "Your organization owner or billing administrator manages payment details and plan changes."));
  root.append(payments);
  if (data.ai.overages) {
    const spending = element("section", "commercial-section");
    spending.append(element("h3", "", "Translation spending"), element("p", "", `Estimated AI overage this period: ${money(data.ai.estimatedOverageMinor)}. This excludes your platform subscription, string and seat overages, and tax. Your provider bills BYOK usage separately.`));
    const form = element("form", "commercial-form");
    const label = element("label", "", "Maximum monthly AI overage (USD)");
    const input = element("input"); input.type = "number"; input.min = "0"; input.max = "1000000"; input.step = "0.01"; input.required = true; input.value = String(Number(data.ai.capMinor) / 100); input.disabled = !manage;
    label.append(input); form.append(label, element("p", "", "$0 means no paid AI overage. Chat does not use this budget."));
    const preview = element("button", "", "Review spending limit"); preview.type = "submit"; preview.disabled = !manage; form.append(preview);
    form.addEventListener("submit", (event) => {
      event.preventDefault(); const amountMinor = Math.round(Number(input.value) * 100); form.hidden = true;
      confirmation(spending, { title: "Update translation spending limit", before: money(data.ai.capMinor), after: money(amountMinor), effect: "This sets the maximum additional monthly translation-credit spend. It does not charge your card now.",
        edit: async () => { form.hidden = false; input.focus(); }, cancel: async () => { form.hidden = false; input.value = String(Number(data.ai.capMinor) / 100); preview.focus(); },
        confirm: async () => { await api(`${base}/commercial-settings/ai-credit-cap`, { amountMinor, expectedAmountMinor: String(data.ai.capMinor) }, "PUT"); await renderBilling(root, org, permissions, current); } });
    });
    spending.append(form); root.append(spending);
  }
  const plans = element("section", "commercial-section"); plans.append(element("h3", "", "Platform plans"));
  const grid = element("div", "commercial-plans");
  for (const plan of catalog.plans.filter((p) => p.metadata?.kind !== "trial")) {
    const card = element("article", "commercial-plan");
    const price = plan.prices.find((p) => p.component === "base" || !p.component);
    card.append(element("h4", "", plan.name), element("strong", "", price ? `${money(price.unitAmountMinor, price.currency)} / ${price.billingInterval}` : plan.metadata?.salesAssisted ? "Custom pricing" : "Price setup pending"), element("p", "", "Agent chat included · bring your own Gemini or Meta key on paid plans"));
    const capacity = plan.metadata?.managedStringsIncluded ?? plan.metadata?.managedStrings;
    if (capacity != null) card.append(element("p", "", `${number(capacity)} managed strings${plan.metadata?.managedStringsIncluded ? " included" : ""} · ${number(plan.metadata?.includedAiCredits)} translation credits per month`));
    if (plan.metadata?.nonRefundableAnnualCommit) card.append(element("p", "", "Paid annually in advance; non-refundable. Usage overages invoice monthly."));
    const active = data.account?.planKey === plan.key;
    if (active) card.append(element("span", "commercial-badge", "Current plan"));
    else if (price && manage && data.payment.enabled && !data.payment.hasSubscription) card.append(button(`Review ${plan.name}`, async () => {
      grid.hidden = true;
      confirmation(plans, { title: `Choose ${plan.name}`, before: data.account?.planName || "No plan", after: `${money(price.unitAmountMinor, price.currency)} / ${price.billingInterval}`, effect: "Continue to Stripe to review payment details and authorize the subscription. Any usage overages are separate.",
        cancel: async () => { grid.hidden = false; }, confirm: async () => { const checkout = await api(`${base}/billing/checkout`, { priceKey: price.key }); location.assign(checkout.url); } });
    }, true));
    grid.append(card);
  }
  plans.append(grid); root.append(plans);
  if (data.payment.hasSubscription) plans.append(element("p", "section-copy", "Payment details and invoices are available in the billing portal. Contact billing support for plan changes that are not available there."));
}

async function renderProviders(root, org, permissions, current) {
  const base = `/api/access/organizations/${org}/ai-providers`;
  const data = await api(base);
  if (generation !== current) return;
  root.replaceChildren(element("p", "shell-eyebrow", "YOUR AI CONNECTIONS"), element("h2", "", "AI providers & keys"), element("p", "", "Chat is included and runs on Hedgeling AI. For context-aware translations, choose Hedgeling credits or your organization’s Gemini or Meta account."));
  const canManage = permissions.includes("ai_providers.manage");
  if (!data.eligible) root.append(element("p", "commercial-notice", "Bring your own key is available on paid plans. Your platform subscription remains required."));
  if (!data.storageReady) root.append(element("p", "commercial-notice", "Secure key storage needs administrator setup before keys can be connected."));
  // One preview at a time, including across the two key cards and routing.
  let pending = false;
  const preview = async (container, editor, payload, focus, clear = () => {}) => {
    if (pending) throw new Error("Finish or cancel the current review first.");
    pending = true;
    let proposal;
    try { ({ proposal } = await api(`${base}/preview`, payload)); }
    catch (error) { pending = false; throw error; }
    finally { if (Object.hasOwn(payload, "key")) payload.key = ""; clear(); }
    editor.hidden = true;
    const reject = async () => { await api(`${base}/proposals/${proposal.id}/reject`, {}); pending = false; editor.hidden = false; focus.focus(); };
    confirmation(container, { ...proposal.preview,
      effect: `${proposal.preview.effect} ${proposal.preview.chat}`,
      edit: reject, cancel: reject,
      confirm: async () => { await api(`${base}/proposals/${proposal.id}/confirm`, {}); await renderProviders(root, org, permissions, current); } });
  };
  for (const [provider, name] of [["gemini", "Gemini"], ["meta", "Meta"]]) {
    const saved = data.credentials[provider];
    const ready = data.providers[provider].ready;
    const connection = element("section", "commercial-section"); connection.dataset.provider = provider;
    connection.append(element("h3", "", name), element("p", "", saved ? `Connected · ${saved.maskedKey}` : "No organization key connected"));
    if (!ready) connection.append(element("p", "commercial-notice", `${name} translations need administrator configuration before connecting a key.`));
    const editor = element("div");
    const form = element("form", "commercial-form");
    const label = element("label", "", `${saved ? "Replacement " : ""}${name} API key`);
    const key = element("input"); key.type = "password"; key.autocomplete = "new-password"; key.spellcheck = false; key.required = true; key.minLength = 20; key.maxLength = provider === "meta" ? 4096 : 512;
    key.disabled = !canManage || !data.eligible || !data.storageReady || !ready; label.append(key);
    const review = element("button", "", saved ? "Review replacement" : "Review connection"); review.type = "submit"; review.disabled = key.disabled;
    form.append(label, element("p", "section-copy", "Saved encrypted. Never paste provider keys into agent chat."), review); editor.append(form);
    const error = element("p", "commercial-error"); error.setAttribute("role", "alert");
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); review.disabled = true; error.textContent = "";
      try { await preview(connection, editor, { action: "connect", provider, key: key.value.trim() }, key, () => { key.value = ""; }); }
      catch (e) { error.textContent = e.message; }
      finally { review.disabled = false; }
    });
    const status = element("p", "section-copy", saved?.validatedAt ? `Last checked ${date(saved.validatedAt)}` : "Test the connection after saving to verify model access."); status.setAttribute("role", "status");
    const controls = element("div", "commercial-actions");
    if (saved && canManage) {
      const test = button("Test saved key", async () => { const result = await api(`${base}/test`, { provider }); status.textContent = `Access checked ${date(result.checkedAt)} · ${result.model}. No translation was generated.`; });
      test.disabled = !data.eligible || !data.storageReady || !ready;
      const remove = button("Remove key", () => preview(connection, editor, { action: "remove", provider }, remove));
      controls.append(test, remove);
    }
    editor.append(controls, status); connection.append(editor, error); root.append(connection);
  }
  const section = element("section", "commercial-section");
  const routing = element("fieldset", "commercial-routing"); routing.append(element("legend", "", "Who pays for AI translations?"));
  for (const [provider, title, description] of [
    ["managed", "Hedgeling AI", "Uses included translation credits, then your approved overage allowance."],
    ["gemini", "My organization’s Gemini key", "Google bills your organization directly. No Hedgeling translation-credit charge."],
    ["meta", "My organization’s Meta key", "Meta bills your organization directly. No Hedgeling translation-credit charge."],
  ]) {
    const mode = provider === "managed" ? "managed" : "byok";
    const selected = data.translationMode === mode && (mode === "managed" || data.translationProvider === provider);
    const option = button(`${title}${selected ? " · Selected" : ""}`, () => preview(section, routing, { action: "translation_mode", mode, provider: mode === "managed" ? "gemini" : provider }, option));
    option.className = `commercial-provider-choice ${selected ? "selected" : ""}`;
    option.setAttribute("aria-pressed", String(selected));
    option.append(element("small", "", description));
    option.disabled = !canManage || selected || (mode === "byok" && (!data.eligible || !data.credentials[provider] || !data.storageReady || !data.providers[provider].ready)); routing.append(option);
  }
  section.append(routing); root.append(section);
  if (data.translationMode === "byok" && !data.credentials[data.translationProvider]) root.append(element("p", "commercial-notice", "AI translations are paused: connect a key or explicitly select Hedgeling AI. We will not switch billing accounts automatically."));
}

export async function load(org, permissions) {
  const current = ++generation;
  await Promise.all([["billingConsole", "billing.view", renderBilling], ["aiProvidersConsole", "ai_providers.view", renderProviders]].map(async ([id, permission, render]) => {
    const root = document.getElementById(id); if (!root) return;
    root.replaceChildren();
    if (!permissions.includes(permission)) return;
    root.append(element("p", "", "Loading…"));
    try { await render(root, org, permissions, current); }
    catch (error) { if (generation === current) root.replaceChildren(element("p", "commercial-error", error.message)); }
  }));
}
