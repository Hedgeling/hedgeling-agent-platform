import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDirectory = path.resolve(__dirname, "..", "src", "operator-ui");

async function fixtureFiles() {
  const [html, css, script] = await Promise.all([
    fs.readFile(path.join(uiDirectory, "operations.html"), "utf8"),
    fs.readFile(path.join(uiDirectory, "operations.css"), "utf8"),
    fs.readFile(path.join(uiDirectory, "operations.js"), "utf8"),
  ]);
  return { html, css, script };
}

async function installFixture(page, { manage = true, replayMode = "success" } = {}) {
  const files = await fixtureFiles();
  const requests = [];
  let providerEvent = {
    providerEventId: "evt_operator_failed",
    eventType: "payout.failed",
    domain: "payout",
    livemode: false,
    status: "failed",
    replayStatus: "not_requested",
    attempts: 2,
    lastError: "Connected account mapping is unavailable",
    receivedAt: "2026-07-25T12:00:00.000Z",
    processedAt: null,
    targetResourceType: "facilitated_payout",
    targetResourceId: "00000000-0000-4000-8000-000000000111",
    connectedAccountContext: "acct_operator",
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), url: url.toString(), body: request.postDataJSON?.() });
    if (url.pathname === "/operations") {
      return route.fulfill({ status: 200, contentType: "text/html", body: files.html });
    }
    if (url.pathname === "/operations.css") {
      return route.fulfill({ status: 200, contentType: "text/css", body: files.css });
    }
    if (url.pathname === "/operations.js") {
      return route.fulfill({ status: 200, contentType: "text/javascript", body: files.script });
    }
    if (["/theme.js", "/design-system/theme.css"].includes(url.pathname)) {
      return route.fulfill({
        status: 200,
        contentType: url.pathname.endsWith(".js") ? "text/javascript" : "text/css",
        body: "",
      });
    }
    if (url.pathname === "/hedgeling-logo.png") return route.abort();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          auth: {
            principalType: "user",
            user: { id: "00000000-0000-4000-8000-000000000001", platformStaff: false },
            platformOperations: { view: true, manage },
          },
        },
      });
    }
    if (url.pathname.endsWith("/operations")) {
      return route.fulfill({
        json: {
          counts: {
            activeAttempts: 1,
            transferQueue: 2,
            refundQueue: 0,
            nonterminalPayouts: 1,
            failedProviderEvents: providerEvent.status === "failed" ? 1 : 0,
            openExceptions: 1,
            openRecoveryCases: 1,
            stalePayoutReconciliations: 1,
          },
          certification: { ready: false, missing: ["support_runbook"] },
        },
      });
    }
    if (url.pathname.endsWith("/provider-events")) {
      return route.fulfill({ json: { events: [providerEvent] } });
    }
    if (url.pathname.endsWith(`/provider-events/${providerEvent.providerEventId}/replay`)) {
      if (replayMode === "in_progress") {
        return route.fulfill({
          status: 409,
          json: {
            error: `Stripe Connect event ${providerEvent.providerEventId} is already being replayed`,
            code: "provider_event_replay_in_progress",
          },
        });
      }
      const body = request.postDataJSON();
      if (
        body.confirmEventId !== providerEvent.providerEventId
        || body.reason !== "Mapping corrected under incident OPS-42"
      ) {
        return route.fulfill({ status: 400, json: { error: "Replay confirmation is invalid" } });
      }
      providerEvent = {
        ...providerEvent,
        status: "ignored",
        replayStatus: "succeeded",
        lastError: null,
        processedAt: "2026-07-25T12:05:00.000Z",
      };
      return route.fulfill({
        json: {
          duplicate: false,
          status: "ignored",
          replayed: true,
          correlationId: request.headers()["x-correlation-id"],
        },
      });
    }
    if (url.pathname.endsWith("/payout-reconciliation")) {
      return route.fulfill({
        json: {
          maximumLagMinutes: 60,
          checkpoints: [{
            connectedAccountId: "00000000-0000-4000-8000-000000000222",
            agencyOrganizationId: "00000000-0000-4000-8000-000000000333",
            providerAccountId: "acct_operator",
            providerMode: "test",
            scanStatus: "failed",
            stale: true,
            lastSuccessfulScanAt: null,
            observedCount: 12,
            changedCount: 2,
            unchangedCount: 10,
            lastError: "Stripe request timed out",
          }],
        },
      });
    }
    if (url.pathname.includes("/accounts/") && url.pathname.endsWith("/payouts/reconcile")) {
      return route.fulfill({
        json: {
          connectedAccountId: "00000000-0000-4000-8000-000000000222",
          status: "succeeded",
          counts: { observed: 1, changed: 0, unchanged: 1 },
        },
      });
    }
    if (url.pathname.endsWith("/payouts/reconcile")) {
      return route.fulfill({
        json: {
          providerMode: "test",
          outcomes: [{ connectedAccountId: "00000000-0000-4000-8000-000000000222", status: "succeeded" }],
        },
      });
    }
    if (url.pathname.endsWith("/reconcile")) {
      return route.fulfill({
        json: {
          outcomes: [{
            id: "00000000-0000-4000-8000-000000000444",
            resourceType: "facilitated_payment_attempt",
            status: "reconciled",
          }],
        },
      });
    }
    if (url.pathname.endsWith("/exceptions")) {
      return route.fulfill({
        json: {
          exceptions: [{
            id: "00000000-0000-4000-8000-000000000555",
            exceptionType: "payout_reconciliation_failed",
            severity: "high",
            status: "open",
            resourceType: "agency_connected_account",
            resourceId: "00000000-0000-4000-8000-000000000222",
            createdAt: "2026-07-25T12:01:00.000Z",
          }],
        },
      });
    }
    if (url.pathname.includes("/exceptions/") && url.pathname.endsWith("/resolve")) {
      return route.fulfill({ json: { exception: { status: "resolved" } } });
    }
    if (url.pathname.endsWith("/recovery-cases")) {
      return route.fulfill({
        json: {
          recoveryCases: [{
            id: "00000000-0000-4000-8000-000000000666",
            caseType: "payout_failure",
            status: "open",
            exposureMinor: "7200",
            currency: "USD",
            createdAt: "2026-07-25T12:02:00.000Z",
          }],
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: `Unhandled ${url.pathname}` } });
  });
  return { requests };
}

test("operator can filter redacted events, replay explicitly, and reconcile", async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto("/operations");

  await expect(page.getByRole("heading", { name: "Payment operations" })).toBeVisible();
  await expect(page.getByText("Connected account mapping is unavailable")).toBeVisible();
  await expect(page.getByText("raw_customer_email@example.com")).toHaveCount(0);

  await page.getByLabel("Domain").selectOption("payout");
  await page.getByLabel("Status").selectOption("failed");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => fixture.requests.some((request) => (
    request.url.includes("domain=payout") && request.url.includes("status=failed")
  ))).toBe(true);

  await page.getByRole("button", { name: "Replay" }).click();
  await expect(page.getByRole("dialog")).toContainText("evt_operator_failed");
  await page.getByLabel("Reason").fill("Mapping corrected under incident OPS-42");
  await page.getByLabel("Type the exact event ID to confirm").fill("evt_operator_failed");
  await page.getByRole("button", { name: "Replay event" }).click();
  await expect(page.getByText("Provider-event replay")).toBeVisible();
  await expect(page.getByText("replay succeeded")).toBeVisible();

  await page.getByRole("button", { name: "Reconcile open payments" }).click();
  await expect(page.getByText("Open-payment reconciliation")).toBeVisible();
  await page.getByRole("button", { name: "Scan payout accounts" }).click();
  await expect(page.getByText("Payout fleet reconciliation")).toBeVisible();
});

test("read-only operator sees recovery state without mutation controls", async ({ page }) => {
  await installFixture(page, { manage: false });
  await page.goto("/operations");
  await expect(page.getByText("Read-only access")).toBeVisible();
  await expect(page.getByRole("button", { name: "Replay" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Scan payout accounts" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(0);
  await expect(page.getByText("Stripe request timed out")).toBeVisible();
});

test("concurrent provider-event replay stays actionable and surfaces the conflict", async ({ page }) => {
  await installFixture(page, { replayMode: "in_progress" });
  await page.goto("/operations");
  await page.getByRole("button", { name: "Replay" }).click();
  await page.getByLabel("Reason").fill("Mapping corrected under incident OPS-42");
  await page.getByLabel("Type the exact event ID to confirm").fill("evt_operator_failed");
  await page.getByRole("button", { name: "Replay event" }).click();
  await expect(page.getByText("Stripe Connect event evt_operator_failed is already being replayed"))
    .toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Replay event" })).toBeEnabled();
});
