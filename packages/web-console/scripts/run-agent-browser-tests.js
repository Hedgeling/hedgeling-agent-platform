import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium, expect } from "@playwright/test";
import { localConsole } from "../test-support/local-console.mjs";
import { buildBrand } from "../../design-system/build.mjs";

const app = await localConsole(process.env.TEST_DATABASE_URL || process.argv[2]);
const artifacts = process.env.HEDGELING_AGENT_BROWSER_ARTIFACTS || await fs.mkdtemp(path.join(os.tmpdir(), "hedgeling-agent-browser-"));
await fs.mkdir(artifacts, { recursive: true });
let browser;
try {
  const executablePath = process.env.HEDGELING_E2E_CHROMIUM_EXECUTABLE || process.argv[3];
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce" });
  const separator = app.cookie.indexOf("=");
  await context.addCookies([{ name: app.cookie.slice(0, separator), value: app.cookie.slice(separator + 1), url: app.origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  const shell = page.locator("#hedgelingAgent");
  await expect(shell).toBeVisible();
  await expect(shell).toHaveAttribute("data-mode", "overlay");
  assert.equal(await page.locator("body > main").evaluate((node) => node.inert), true);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await shell.locator("#agentInput").evaluate((node) => getComputedStyle(node).fontFamily.includes("Courier Prime")), true);
  assert.equal(await page.evaluate(() => document.fonts.check('15px "Courier Prime"')), true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await shell.locator("#agentInput").press("h");
  await shell.locator("#agentInput").fill("");
  await page.screenshot({ path: path.join(artifacts, "01-overlay.png") });
  await shell.getByRole("button", { name: "Set up demo workspace", exact: true }).click();
  await shell.getByRole("button", { name: "Send message", exact: true }).click();
  for (const [index, name] of ["Create organization", "Create business unit", "Create project", "Create job draft"].entries()) {
    const button = shell.locator(".agent-proposal").getByRole("button", { name, exact: true });
    await expect(button).toBeVisible({ timeout: 15000 }); await expect(button).toBeEnabled();
    if (index === 0) {
      assert.equal((await app.database.query("select count(*)::int as n from organizations where name='Demo organization'")).rows[0].n, 0);
      await expect(page.locator('#workspaceTab')).toHaveAttribute("data-agent-attention", "approval");
      await expect(page.locator('[data-workspace-action="organization.create"] summary')).toHaveAttribute("data-agent-attention", "approval");
      await expect(shell.locator('.agent-proposal')).toHaveAttribute("data-agent-attention", "approval");
      await shell.getByRole("button", { name: "Side panel", exact: true }).click();
      await page.screenshot({ path: path.join(artifacts, "02-confirmation.png") });
      await shell.locator("#agentFollow").uncheck();
      await expect(page.locator("[data-agent-attention]")).toHaveCount(0);
      await shell.locator("#agentFollow").check();
      await shell.locator("#agentPause").click();
      await expect(button).toBeDisabled();
      await expect(page.locator("[data-agent-attention]")).toHaveCount(0);
      await shell.locator("#agentResume").click();
      await expect(button).toBeEnabled();
    }
    await button.click();
  }
  await expect(shell.getByText("Your organization, Product business unit, Website project and localization-job draft are ready.", { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#workspaceRoot [data-resource-type="job"]')).toHaveAttribute("data-agent-attention", "complete");
  await page.screenshot({ path: path.join(artifacts, "03-result-highlight.png") });
  await shell.getByRole("button", { name: "Take over", exact: true }).click();
  await expect(page.locator("[data-agent-attention]")).toHaveCount(0);
  await expect(shell).toBeHidden();
  assert.equal(await page.locator("body > main").evaluate((node) => node.inert), false);
  await expect(page.locator("#workspaceRoot").getByText("Website launch", { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "03-manual-workspace.png") });
  await page.getByRole("button", { name: /Open Hedgeling assistant/ }).click();
  await expect(shell).toHaveAttribute("data-mode", "panel");
  await expect(shell.locator("#agentResume")).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "04-side-panel.png") });
  await shell.locator("#agentResume").click();
  await expect(shell.locator("#agentInput")).toBeEnabled();
  await shell.locator("#agentInput").fill("Show my projects");
  await shell.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#workspaceTab")).toHaveAttribute("data-agent-attention", "working");
  await page.locator('.sidebar-nav [data-view="home"]').click();
  await expect(shell.locator("#agentFollow")).not.toBeChecked();
  await expect(page.locator("[data-agent-attention]")).toHaveCount(0);
  await expect(shell.locator("#agentInput")).toBeEnabled();
  await shell.getByRole("button", { name: "Full-screen chat", exact: true }).click();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.closest("#hedgelingAgent") !== null), true);
  await shell.locator("#agentOpaque").click();
  await expect(shell).toHaveAttribute("data-opaque", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.screenshot({ path: path.join(artifacts, "05-mobile-light.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.reload();
  await expect(shell).toBeVisible();
  await expect(shell.getByText("Website launch is ready as a draft.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-agent-attention]")).toHaveCount(0);
  // The playground uses the same cards without sending any writes.
  const preview = await context.newPage();
  const mutations = [];
  preview.on("request", (request) => { if (!["GET", "HEAD"].includes(request.method())) mutations.push(request.url()); });
  preview.on("pageerror", (error) => errors.push(error.message));
  await preview.goto(`${app.origin}/agent-preview.html`);
  await preview.locator("[data-theme-preference]").selectOption("light");
  await preview.getByRole("button", { name: "Create job draft", exact: true }).click();
  await expect(preview.getByText("Preview approved. No workspace changes were made.")).toBeVisible();
  await preview.getByRole("button", { name: "02 Options" }).click();
  await preview.getByRole("radio", { name: /Human translation \+ review/ }).check();
  await preview.screenshot({ path: path.join(artifacts, "07-option-cards-light.png"), fullPage: true });
  await preview.getByRole("button", { name: "Send answer" }).click();
  await expect(preview.getByText("Example answer received. No workspace changes were made.")).toBeVisible();
  await preview.getByRole("button", { name: "03 Free-form" }).click();
  await preview.getByRole("button", { name: "Use these details" }).click();
  await expect(preview.getByLabel("Project name")).toBeFocused();
  await preview.getByLabel("Project name").fill("Autumn launch");
  await preview.getByLabel("Target languages").fill("French, German");
  await preview.getByLabel("Anything else?").fill("A warm, conversational tone.");
  await preview.screenshot({ path: path.join(artifacts, "08-free-form-light.png"), fullPage: true });
  await preview.getByRole("button", { name: "Use these details" }).click();
  await expect(preview.getByText("Example answer received. No workspace changes were made.")).toBeVisible();
  await preview.getByLabel("Message the assistant").fill("A sample note");
  await preview.getByLabel("Message the assistant").press("Enter");
  await expect(preview.locator("#previewReply")).toContainText("Nothing was sent to the agent");
  await preview.getByRole("button", { name: "Try an attention highlight" }).click();
  await expect(preview.locator("#previewHighlightTarget")).toHaveAttribute("data-agent-attention", "working");
  await preview.getByRole("button", { name: "01 Approval" }).click();
  await preview.locator("[data-theme-preference]").selectOption("dark");
  await preview.screenshot({ path: path.join(artifacts, "09-approval-dark.png"), fullPage: true });
  await preview.setViewportSize({ width: 390, height: 844 });
  assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await preview.screenshot({ path: path.join(artifacts, "10-preview-mobile.png"), fullPage: true });
  await preview.locator("[data-theme-preference]").selectOption("light");
  assert.deepEqual(mutations, []);
  await preview.close();
  // Render a replacement brand through the same components, using the actual
  // generated manifest, CSS and assets. Leave the working tree's brand alone.
  const alternate = path.join(artifacts, "aurora-brand");
  await buildBrand("aurora", alternate);
  await page.route("**/design-system/**", (route) => {
    const relative = new URL(route.request().url()).pathname.replace("/design-system/", "");
    return route.fulfill({ path: path.join(alternate, relative) });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(shell.locator("[data-agent-name]")).toHaveText("Aurora");
  await expect(shell.locator(".agent-avatar")).toHaveAttribute("src", "/design-system/assets/mark.svg");
  const alternateTokens = JSON.parse(await fs.readFile(path.join(alternate, "tokens.json")));
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent-green").trim()), alternateTokens.light["accent-green"]);
  await page.screenshot({ path: path.join(artifacts, "06-alternate-brand.png") });
  await shell.getByRole("button", { name: "Minimize chat", exact: true }).click();
  await page.goto(`${app.origin}/onboarding`);
  await expect(page.getByRole("button", { name: /Open Aurora assistant/ })).toBeVisible();
  await page.getByRole("button", { name: /Open Aurora assistant/ }).click();
  await expect(shell).toBeVisible();
  // Inventory must include the second page, and job browsing must reach records
  // older than the initial 100 organization jobs without duplicate rows.
  const project = (await app.database.query(`select p.id,p.slug,b.organization_id as org from projects p join business_units b on b.id=p.business_unit_id where p.name='Website'`)).rows[0];
  await app.database.query(`with units as (insert into business_units(organization_id,slug,name)
    select $1,'paged-unit-'||n,'Paged unit '||n from generate_series(1,105) n returning id,slug)
    insert into projects(business_unit_id,slug,name) select id,slug,'Paged project '||substring(slug from 12) from units`, [project.org]);
  await app.database.query(`insert into localization_jobs(project_id,name,source_locale,target_locales,steps)
    select $1,'Paged job '||n,'en',array['fr'],array['review'] from generate_series(1,105) n`, [project.id]);
  await shell.getByRole("button", { name: "Minimize chat", exact: true }).click();
  await page.goto(app.origin);
  await expect(page.getByRole("button", { name: /Open Aurora assistant/ })).toBeVisible();
  await page.evaluate(async (id) => { await window.HedgelingAgent.browseWorkspace(id); window.HedgelingConsole.openWorkspace(); }, project.org);
  await expect(page.locator('#workspaceRoot [data-resource-type="project"]')).toHaveCount(106);
  await page.getByRole("button", { name: "Browse jobs in Website", exact: true }).click();
  await expect(page.getByText("50 of 106 jobs shown", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more jobs in Website", exact: true }).click();
  await expect(page.getByText("100 of 106 jobs shown", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more jobs in Website", exact: true }).click();
  await expect(page.getByText("106 of 106 jobs shown", { exact: true })).toBeVisible();
  assert.equal(await page.locator('#workspaceRoot [data-resource-type="job"]').evaluateAll((nodes) => new Set(nodes.map((n) => n.dataset.resourceId)).size), 106);
  await expect(page.locator("#workspaceRoot").getByText("Website launch", { exact: true })).toBeVisible();
  // Edit an older job from the last page. The preview shows only changed fields,
  // and the saved item stays visible when the workspace refreshes.
  const jobEdit = page.locator('details[data-workspace-action="localization_job.update"]').filter({ has: page.getByText("Edit job: Website launch", { exact: true }) });
  await jobEdit.locator("summary").click();
  await jobEdit.getByLabel("Job name", { exact: true }).fill("Spring launch");
  await jobEdit.getByLabel("Target languages, separated by commas").fill("fr");
  await jobEdit.getByLabel("Quality check", { exact: true }).check();
  await jobEdit.getByRole("button", { name: "Preview change", exact: true }).click();
  await expect(jobEdit.locator(".agent-change")).toHaveCount(3);
  assert.equal((await app.database.query("select name from localization_jobs where name='Website launch'")).rowCount, 1);
  await expect(jobEdit.getByLabel("Job name", { exact: true })).toBeHidden();
  const firstReviewId = await jobEdit.locator(".workspace-confirmation").getAttribute("data-proposal-id");
  await jobEdit.getByRole("button", { name: "Edit details", exact: true }).click();
  await expect(jobEdit.getByLabel("Job name", { exact: true })).toBeFocused();
  await expect(jobEdit.getByLabel("Job name", { exact: true })).toHaveValue("Spring launch");
  await expect(jobEdit.getByLabel("Quality check", { exact: true })).toBeChecked();
  assert.equal((await app.database.query("select status from agent_proposals where id=$1", [firstReviewId])).rows[0].status, "rejected");
  await jobEdit.getByRole("button", { name: "Preview change", exact: true }).click();
  const cancelledReviewId = await jobEdit.locator(".workspace-confirmation").getAttribute("data-proposal-id");
  await jobEdit.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(jobEdit.locator("summary")).toBeFocused();
  assert.equal((await app.database.query("select status from agent_proposals where id=$1", [cancelledReviewId])).rows[0].status, "rejected");
  assert.equal((await app.database.query("select name from localization_jobs where name='Website launch'")).rowCount, 1);
  await jobEdit.locator("summary").click();
  await expect(jobEdit.getByLabel("Job name", { exact: true })).toHaveValue("Website launch");
  await expect(jobEdit.getByLabel("Quality check", { exact: true })).not.toBeChecked();
  await jobEdit.getByLabel("Job name", { exact: true }).fill("Spring launch");
  await jobEdit.getByLabel("Target languages, separated by commas").fill("fr");
  await jobEdit.getByLabel("Quality check", { exact: true }).check();
  await jobEdit.getByRole("button", { name: "Preview change", exact: true }).click();
  await jobEdit.screenshot({ path: path.join(artifacts, "12-manual-review-light.png") });
  await jobEdit.getByRole("button", { name: "Save job changes", exact: true }).click();
  await expect(page.locator("#workspaceRoot").getByText("Spring launch", { exact: true })).toBeVisible();
  const updatedJob = (await app.database.query("select target_locales,steps,source_snapshot from localization_jobs where name='Spring launch'")).rows[0];
  assert.deepEqual(updatedJob.target_locales, ["fr"]); assert.deepEqual(updatedJob.steps, ["machine_translation", "review", "qa"]); assert.deepEqual(updatedJob.source_snapshot, []);
  for (const edit of [
    { action: "project.update", summary: "Edit project: Website", field: "Project name", value: "Marketing website", save: "Save project name" },
    { action: "business_unit.update", summary: "Edit business unit: Product", field: "Business-unit name", value: "Growth", save: "Save business-unit name" },
    { action: "organization.update", summary: "Edit organization name", field: "Organization name", value: "Spring workspace", save: "Save organization name" },
  ]) {
    const details = page.locator(`details[data-workspace-action="${edit.action}"]`).filter({ has: page.getByText(edit.summary, { exact: true }) });
    await details.locator("summary").click();
    await details.getByLabel(edit.field, { exact: true }).fill(edit.value);
    await details.getByRole("button", { name: "Preview change", exact: true }).click();
    await expect(details.locator(".agent-change-after")).toHaveText(edit.value);
    await details.getByRole("button", { name: edit.save, exact: true }).click();
    if (edit.action === "organization.update") await expect(page.getByRole("combobox", { name: "Workspace organization", exact: true }).locator("option:checked")).toHaveText(edit.value);
    else await expect(page.getByText(`${edit.action === "project.update" ? "Edit project" : "Edit business unit"}: ${edit.value}`, { exact: true })).toBeVisible();
  }
  const projectCreate = page.locator('details[data-workspace-action="project.create"]');
  await projectCreate.locator("summary").click();
  await projectCreate.getByLabel("Project name", { exact: true }).fill("Documentation");
  await projectCreate.getByRole("button", { name: "Preview change", exact: true }).click();
  await expect(projectCreate.getByRole("heading", { name: "Review details", exact: true })).toBeFocused();
  await projectCreate.getByRole("button", { name: "Edit details", exact: true }).click();
  await expect(projectCreate.getByLabel("Project name", { exact: true })).toHaveValue("Documentation");
  await projectCreate.getByRole("button", { name: "Preview change", exact: true }).click();
  await page.evaluate(() => { const control = document.querySelector("select[data-theme-preference]"); control.value = "dark"; control.dispatchEvent(new Event("change", { bubbles: true })); });
  await projectCreate.screenshot({ path: path.join(artifacts, "13-manual-create-review-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await projectCreate.screenshot({ path: path.join(artifacts, "14-manual-create-review-mobile.png") });
  await projectCreate.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await app.database.query("select count(*)::int as n from projects where name='Documentation'")).rows[0].n, 0);
  await page.screenshot({ path: path.join(artifacts, "11-workspace-management.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Agent browser checks passed: creation and edit confirmations, semantic highlights, manual override, compact typewriter, zero-write card examples, focus, mobile, replay, second brand, onboarding launcher, and inventory/job pagination beyond 100. Screenshots: ${artifacts}`);
} finally { console.log(`Browser artifacts: ${artifacts}`); await browser?.close(); await app.close(); }
