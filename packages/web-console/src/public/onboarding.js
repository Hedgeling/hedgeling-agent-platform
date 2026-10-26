const loading = document.querySelector("#loading");
const setupView = document.querySelector("#setupView");
const workspaceView = document.querySelector("#workspaceView");
const message = document.querySelector("#message");
let status = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    location.assign("/login?next=/onboarding");
    throw new Error("Authentication required");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The request could not be completed");
  return data;
}

function formattedDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function money(amount, currency) {
  if (amount == null) return "Price configured in Stripe";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(Number(amount) / 100);
}

function dollarsToMinorUnits(value) {
  const normalized = String(value || "").trim();
  if (!/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(normalized)) {
    throw new Error("Enter a USD amount from 0.00 to 1,000,000.00");
  }
  const [whole, fraction = ""] = normalized.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

async function renderSpendControls(workspace) {
  const panel = document.querySelector("#spendControls");
  if (workspace.planMetadata?.kind !== "business") {
    panel.hidden = true;
    return;
  }
  const settings = await request(
    `/api/access/organizations/${workspace.organizationId}/commercial-settings`,
  );
  document.querySelector("#aiOverageCap").value = (
    Number(settings.spendControls.aiCreditOverageCapMinor || 0) / 100
  ).toFixed(2);
  panel.hidden = false;
}

async function renderNpmSeats(workspace) {
  const panel = document.querySelector("#npmSeatsPanel");
  if (
    Number(workspace.planMetadata?.npmSeatsIncluded || 0) < 1
    || !["trialing", "active"].includes(workspace.subscriptionState)
  ) {
    panel.hidden = true;
    return;
  }
  const data = await request(
    `/api/access/organizations/${workspace.organizationId}/npm-seats`,
  );
  const maximum = data.policy.maximum == null
    ? "no contractual maximum"
    : `a maximum of ${data.policy.maximum}`;
  document.querySelector("#npmSeatPolicy").textContent =
    `${data.policy.planName} includes ${data.policy.included} seat(s) and allows ${maximum}. `
    + "Additional seats are billed from the monthly high-water mark without proration.";
  const list = document.querySelector("#npmSeatList");
  const current = data.seats.filter((seat) => seat.status !== "revoked");
  list.innerHTML = current.length
    ? current.map((seat) => `
        <div class="seat-row">
          <div>
            <strong>@${escapeHtml(seat.npmUsername)}</strong>
            <small>${escapeHtml(seat.status.replaceAll("_", " "))}</small>
          </div>
          <button type="button" class="remove-npm-seat" data-seat-id="${escapeHtml(seat.id)}">Remove</button>
        </div>
      `).join("")
    : '<p class="muted">No npm members have been provisioned yet.</p>';
  list.querySelectorAll(".remove-npm-seat").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      showMessage("");
      try {
        await request(
          `/api/access/organizations/${workspace.organizationId}`
          + `/npm-seats/${button.dataset.seatId}`,
          { method: "DELETE" },
        );
        await renderNpmSeats(workspace);
      } catch (error) {
        showMessage(error.message);
        button.disabled = false;
      }
    });
  });
  panel.hidden = false;
}

function renderTrialPackage(workspace) {
  const panel = document.querySelector("#trialPackagePanel");
  const policy = status?.configuration?.trialPackage;
  const isTrial = workspace.planMetadata?.kind === "trial"
    || workspace.planKey === "self-service-trial-v1";
  if (!isTrial) {
    panel.hidden = true;
    return;
  }
  const active = (
    workspace.subscriptionState === "trialing"
    && new Date(workspace.trialEndsAt).getTime() > Date.now()
  );
  const button = document.querySelector("#requestTrialPackage");
  button.disabled = !active || !policy?.enabled;
  document.querySelector("#trialPackageLink").hidden = true;
  document.querySelector("#trialPackageEvidence").hidden = true;
  document.querySelector("#trialPackagePolicy").textContent = !active
    ? "The package download closes when the trial ends. Upgrade to Starter for private npm access."
    : policy?.enabled
      ? `Generate a link valid for up to ${Math.round(policy.ttlSeconds / 60)} minutes. `
        + "The installed package still requires a current signed Hedgeling lease."
      : "Trial package distribution is not configured in this environment yet.";
  panel.hidden = false;
}

function renderWorkflows(configuration) {
  const choices = document.querySelector("#workflowChoices");
  choices.innerHTML = configuration.workflows.map((workflow, index) => `
    <label class="workflow-option">
      <input type="radio" name="workflow" value="${escapeHtml(workflow.key)}" ${index === 1 ? "checked" : ""}>
      <span class="workflow-card">
        <strong>${escapeHtml(workflow.name)}</strong>
        <small>${escapeHtml(workflow.description)}</small>
      </span>
    </label>
  `).join("");
}

function listPrice(plan) {
  const configured = plan.metadata?.listPrice || plan.metadata?.startsAt;
  if (!configured) return null;
  return {
    unitAmountMinor: configured.unitAmountMinor,
    currency: configured.currency || "USD",
    billingInterval: configured.interval,
  };
}

function planHighlights(plan) {
  const metadata = plan.metadata || {};
  if (metadata.kind === "starter") {
    return [
      `${Number(metadata.managedStrings).toLocaleString()} managed strings`,
      `${metadata.targetLocales} target locales`,
      `${Number(metadata.includedAiCredits).toLocaleString()} AI credits/month`,
      "Efficient managed Gemini model",
      "Agent chat included · organization Gemini keys supported",
      `${metadata.npmSeatsIncluded} private npm seat included`,
    ];
  }
  if (metadata.kind === "business") {
    return [
      `${Number(metadata.managedStringsIncluded).toLocaleString()} managed strings included`,
      `Overages up to ${Number(metadata.managedStringsMaximum).toLocaleString()} strings`,
      "Unlimited target locales",
      `${Number(metadata.includedAiCredits).toLocaleString()} AI credits/month`,
      "Frontier-model access",
      "Agent chat included · organization Gemini keys supported",
      `${metadata.npmSeatsIncluded} private npm seats included`,
    ];
  }
  return [
    "Agent chat included",
    "Custom managed-string and AI-credit capacity",
    "Dedicated parsing isolation",
    "Enterprise identity and security controls",
    "Custom model and BYOK options",
  ];
}

async function renderPlans(workspace) {
  const catalog = await request("/api/billing/plans");
  const paidPlans = catalog.plans.filter((plan) => plan.metadata?.kind !== "trial");
  const grid = document.querySelector("#planGrid");
  if (!paidPlans.length) {
    grid.innerHTML = `
      <div class="empty-plans">
        Paid plan names and Stripe prices have not been published in this environment yet.
        Your trial is active; no payment method was collected.
      </div>
    `;
    return;
  }
  grid.innerHTML = paidPlans.map((plan) => {
    const prices = (plan.prices || []).filter((price) => (
      !price.component || price.component === "base"
    ));
    const advertisedPrice = prices[0] || listPrice(plan);
    const priceChoices = prices.length
      ? prices.map((price) => `
          <button class="upgrade-plan primary" data-price-key="${escapeHtml(price.key)}" ${!catalog.checkoutEnabled ? "disabled" : ""}>
            ${escapeHtml(money(price.unitAmountMinor, price.currency))}/${escapeHtml(price.billingInterval)}
            <span aria-hidden="true">→</span>
          </button>
        `).join("")
      : plan.metadata?.salesAssisted
        ? '<a class="button" href="mailto:sales@thehedgeling.com">Contact sales</a>'
        : advertisedPrice
          ? `<p class="price">${escapeHtml(money(advertisedPrice.unitAmountMinor, advertisedPrice.currency))}/${escapeHtml(advertisedPrice.billingInterval)} <small>Stripe price setup pending</small></p>`
          : '<p class="price">Price setup pending</p>';
    const billingNote = plan.metadata?.nonRefundableAnnualCommit
      ? '<p class="plan-note">Paid annually in advance; non-refundable. Usage overages invoice monthly.</p>'
      : "";
    return `
      <article class="plan-card">
        <p class="eyebrow">${escapeHtml(plan.metadata?.kind || "Paid")}</p>
        <h2>${escapeHtml(plan.name)}</h2>
        <p>${escapeHtml(plan.metadata?.description || "")}</p>
        <ul>${planHighlights(plan).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        ${billingNote}
        ${priceChoices}
      </article>
    `;
  }).join("");
  grid.querySelectorAll(".upgrade-plan").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      showMessage("");
      try {
        const checkout = await request(
          `/api/access/organizations/${workspace.organizationId}/billing/checkout`,
          {
            method: "POST",
            body: JSON.stringify({ priceKey: button.dataset.priceKey }),
          },
        );
        location.assign(checkout.url);
      } catch (error) {
        showMessage(error.message);
        button.disabled = false;
      }
    });
  });
}

async function showWorkspace(workspace, credential = null) {
  if (status) status.workspace = workspace;
  loading.hidden = true;
  setupView.hidden = true;
  workspaceView.hidden = false;
  document.querySelector("#workspaceTitle").textContent = `${workspace.organizationName} is ready`;
  const isTrial = workspace.planMetadata?.kind === "trial"
    || workspace.planKey === "self-service-trial-v1";
  const periodMessage = isTrial
    ? new Date(workspace.trialEndsAt).getTime() > Date.now()
      ? `Your free trial runs through ${formattedDate(workspace.trialEndsAt)}.`
      : `Your free trial ended ${formattedDate(workspace.trialEndsAt)}. Retention and the configured export grace remain available.`
    : `${workspace.planMetadata?.kind || workspace.planKey} is active through ${formattedDate(workspace.trialEndsAt)}.`;
  document.querySelector("#trialSummary").textContent =
    `${periodMessage} The project uses ${workspace.sourceLocale} → ${workspace.targetLocales.join(", ")}.`;
  document.querySelector("#connectionExample").textContent = isTrial
    ? [
      "# Download the time-limited trial artifact above, then install the saved file.",
      `npm install ./${status?.configuration?.trialPackage?.filename || "hedgeling-i18n-<version>.tgz"}`,
      "",
      "# Save the project credential above; it remains usable after upgrade.",
      `export HEDGELING_CONSOLE_URL=${location.origin}`,
      `export HEDGELING_PROJECT_SLUG=${workspace.projectSlug}`,
      "export HEDGELING_CONSOLE_TOKEN=<copy the credential above>",
      "",
      "npx hedgeling lease",
      "npx hedgeling extract",
      `npx hedgeling pull --project ${workspace.projectSlug}`,
      "",
      "# Private npm membership begins on Starter.",
    ].join("\n")
    : [
      "npm install @hedgeling/i18n",
      "",
      `export HEDGELING_CONSOLE_URL=${location.origin}`,
      `export HEDGELING_PROJECT_SLUG=${workspace.projectSlug}`,
      "export HEDGELING_CONSOLE_TOKEN=<copy the credential above>",
      "",
      "npx hedgeling lease",
      "npx hedgeling extract",
      `npx hedgeling pull --project ${workspace.projectSlug}`,
    ].join("\n");
  const upgradeStatus = document.querySelector("#upgradeStatus");
  if (workspace.upgradeProvisioningStatus) {
    upgradeStatus.hidden = false;
    const statusLabel = workspace.upgradeProvisioningStatus.replaceAll("_", " ");
    upgradeStatus.innerHTML = `
      <p class="eyebrow">Upgrade status</p>
      <h2>${escapeHtml(statusLabel)}</h2>
      <p>${workspace.upgradeProvisioningStatus === "requires_action"
        ? "Stripe needs another payment confirmation. Open billing to continue."
        : workspace.upgradeProvisioningStatus === "failed"
          ? escapeHtml(workspace.upgradeProvisioningError || "Provisioning will retry automatically.")
          : "Your annual base and monthly usage subscription is being synchronized."}</p>
    `;
  } else {
    upgradeStatus.hidden = true;
  }
  document.querySelector("#credentialPanel").hidden = false;
  if (credential?.token) {
    document.querySelector("#tokenRow").hidden = false;
    document.querySelector("#replaceCredential").hidden = true;
    document.querySelector("#credentialToken").textContent = credential.token;
  } else {
    document.querySelector("#tokenRow").hidden = true;
    document.querySelector("#replaceCredential").hidden = false;
    document.querySelector("#credentialHelp").textContent =
      "The original credential is no longer displayable. Generate a replacement if you did not save it.";
  }
  renderTrialPackage(workspace);
  await Promise.all([
    renderPlans(workspace),
    renderSpendControls(workspace),
    renderNpmSeats(workspace),
  ]);
}

document.querySelector("#copyToken").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.querySelector("#credentialToken").textContent);
  document.querySelector("#copyToken").textContent = "Copied";
});

document.querySelector("#replaceCredential").addEventListener("click", async () => {
  const button = document.querySelector("#replaceCredential");
  button.disabled = true;
  showMessage("");
  try {
    const workspace = status.workspace;
    const replacement = await request(
      `/api/access/organizations/${workspace.organizationId}`
      + `/service-accounts/${workspace.serviceAccountId}/credentials`,
      {
        method: "POST",
        body: JSON.stringify({
          revokeExisting: true,
          expiresAt: new Date(
            Date.now() + 180 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
      },
    );
    document.querySelector("#credentialToken").textContent =
      replacement.credential.token;
    document.querySelector("#credentialHelp").textContent =
      "Replacement created. Store it as a secret; it will not be shown again.";
    document.querySelector("#tokenRow").hidden = false;
    button.hidden = true;
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#requestTrialPackage").addEventListener("click", async () => {
  const button = document.querySelector("#requestTrialPackage");
  button.disabled = true;
  showMessage("");
  try {
    const data = await request("/api/onboarding/trial-package-download", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const link = document.querySelector("#trialPackageLink");
    link.href = data.download.url;
    link.download = data.download.filename;
    link.textContent = `Download ${data.download.filename}`;
    link.hidden = false;
    document.querySelector("#trialPackageSha").textContent = data.download.sha256;
    document.querySelector("#trialPackageExpiry").textContent =
      `Link expires ${formattedDate(data.download.expiresAt)}.`;
    document.querySelector("#trialPackageEvidence").hidden = false;
    showMessage("Your private download link is ready.");
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#spendControlForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  showMessage("");
  try {
    const workspace = status.workspace;
    const saved = await request(
      `/api/access/organizations/${workspace.organizationId}`
      + "/commercial-settings/ai-credit-cap",
      {
        method: "PUT",
        body: JSON.stringify({
          amountMinor: dollarsToMinorUnits(
            document.querySelector("#aiOverageCap").value,
          ),
        }),
      },
    );
    document.querySelector("#aiOverageCap").value = (
      Number(saved.spendControls.aiCreditOverageCapMinor || 0) / 100
    ).toFixed(2);
    showMessage("AI-credit hard cap saved.");
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#npmSeatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  showMessage("");
  try {
    const workspace = status.workspace;
    await request(
      `/api/access/organizations/${workspace.organizationId}/npm-seats`,
      {
        method: "POST",
        body: JSON.stringify({
          npmUsername: document.querySelector("#npmUsername").value,
        }),
      },
    );
    document.querySelector("#npmUsername").value = "";
    await renderNpmSeats(workspace);
    showMessage("npm access has been queued for provisioning.");
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#workspaceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  showMessage("");
  try {
    const data = await request("/api/onboarding/workspace", {
      method: "POST",
      body: JSON.stringify({
        organizationName: document.querySelector("#organizationName").value,
        projectName: document.querySelector("#projectName").value,
        sourceLocale: document.querySelector("#sourceLocale").value,
        targetLocales: document.querySelector("#targetLocales").value
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        workflowPresetKey: document.querySelector('input[name="workflow"]:checked')?.value,
        acceptedTerms: document.querySelector("#onboardingLegal").checked,
        acceptedPrivacy: document.querySelector("#onboardingLegal").checked,
        termsVersion: status.configuration.termsVersion,
        privacyVersion: status.configuration.privacyVersion,
      }),
    });
    await showWorkspace(data.workspace, data.credential);
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

request("/api/onboarding/status")
  .then(async (data) => {
    status = data;
    document.querySelector("#trialBadge").textContent =
      `${data.configuration.trialDays}-day free trial · no card`;
    if (data.needsWorkspace) {
      document.querySelector("#termsLink").href = data.configuration.termsUrl;
      document.querySelector("#privacyLink").href = data.configuration.privacyUrl;
      renderWorkflows(data.configuration);
      loading.hidden = true;
      setupView.hidden = false;
    } else {
      await showWorkspace(data.workspace);
    }
  })
  .catch((error) => {
    loading.hidden = true;
    showMessage(error.message);
  });
