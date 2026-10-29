import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { setupTranslationJobs } from '../test-support/translation-jobs.mjs';

const cleanup = [];
const app = await setupTranslationJobs({ after: fn => cleanup.push(fn) }, 2);
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'hedgeling-translation-jobs-browser-'));
let browser, page;
try {
  const job = await app.draft('French launch');
  browser = await chromium.launch({ headless: true, ...(process.env.HEDGELING_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.HEDGELING_E2E_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const split = app.cookie.indexOf('=');
  await context.addCookies([{ name: app.cookie.slice(0, split), value: app.cookie.slice(split + 1), url: app.origin, httpOnly: true, sameSite: 'Strict' }]);
  page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.origin);
  const chat = page.locator('#hedgelingAgent');
  await chat.locator('#agentScope').selectOption({ label: 'Local troubleshooting' });
  await expect(chat.locator('#agentInput')).toBeEnabled();
  await chat.getByRole('button', { name: 'Minimize chat', exact: true }).click();
  await page.evaluate(async org => { await window.HedgelingAgent.browseWorkspace(org); window.HedgelingConsole.openWorkspace(); }, app.org);
  const row = page.locator(`[data-resource-type="job"][data-resource-id="${job.id}"]`);
  await row.getByLabel('Maximum translations in this batch').fill('1');
  await row.getByRole('button', { name: 'Preview translation start', exact: true }).click();
  const review = row.locator('.workspace-confirmation');
  await expect(review).toContainText('1 missing source/language pairs');
  await expect(review).toContainText('1 additional missing pairs');
  await expect(review).not.toContainText('tell me');
  assert.equal(app.meta.calls.length, 0);
  await review.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, '01-manual-start-preview.png') });
  await review.getByRole('button', { name: 'Start translation', exact: true }).click();
  await expect(row.locator('[data-translation-job-id]')).toContainText('Drafts ready for review', { timeout: 20000 });
  await expect(row.locator('[data-translation-job-id]')).toContainText('1 of 1 drafts saved');
  await expect(row.getByRole('link', { name: 'Open translations to review' })).toBeVisible();
  assert.equal(app.meta.calls.length, 1);
  await page.screenshot({ path: path.join(artifacts, '02-manual-progress.png') });

  await app.draft('Second French batch');
  await page.evaluate(() => window.HedgelingAgent.open());
  await chat.locator('#agentInput').click();
  await chat.locator('#agentInput').fill('Start translation job "Second French batch"');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  const card = chat.locator('.agent-proposal').filter({ hasText: 'Start translation' });
  await expect(card.getByRole('button', { name: 'Start translation', exact: true })).toBeEnabled();
  assert.equal(app.meta.calls.length, 1);
  await page.screenshot({ path: path.join(artifacts, '03-chat-start-preview.png') });
  await card.getByRole('button', { name: 'Start translation', exact: true }).click();
  await expect(chat.locator('.translation-job-progress')).toContainText('Drafts ready for review', { timeout: 20000 });
  assert.equal(app.meta.calls.length, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await chat.locator('.translation-job-progress').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, '04-mobile-progress.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('Translation job browser flow passed. Artifacts: ' + artifacts);
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error('Artifacts: ' + artifacts); throw error;
} finally {
  await browser?.close(); for (const close of cleanup.reverse()) await close();
}
