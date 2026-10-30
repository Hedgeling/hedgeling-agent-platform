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
  await expect(row.getByLabel('Maximum translations in this batch')).toHaveValue('2');
  await expect(row.getByLabel('Maximum translations in this batch')).toHaveAttribute('max','10000');
  await expect(row).toContainText('one start approval');
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

  await page.setViewportSize({width:1440,height:1000});
  await chat.getByRole('button',{name:'Minimize chat',exact:true}).click();
  await app.database.query("insert into source_strings(project_id,source_hash,source_text) values($1,'validation-one','Hello {name}'),($1,'validation-two','Hello {name}')",[app.project.id]);
  const flagged=await app.draft('Continue after glossary check');
  let release;const gate=new Promise(resolve=>{release=resolve;});cleanup.push(release);
  const before=app.meta.calls.length;
  app.meta.control.beforeResponse=async()=>{
    app.meta.control.text=app.meta.calls.length<=before+2?'Salut {name}':'Bonjour {name}';
    if(app.meta.calls.length===before+3)await gate;
  };
  // This draft was created through the API outside this page's UI state.
  await page.reload();
  await page.waitForFunction(()=>Boolean(window.HedgelingAgent?.browseWorkspace&&window.HedgelingConsole?.openWorkspace));
  await page.evaluate(async org=>{await window.HedgelingAgent.browseWorkspace(org);window.HedgelingConsole.openWorkspace();},app.org);
  const flaggedRow=page.locator(`[data-resource-type="job"][data-resource-id="${flagged.id}"]`);
  await flaggedRow.getByRole('button',{name:'Preview translation start',exact:true}).click();
  await flaggedRow.locator('.workspace-confirmation').getByRole('button',{name:'Start translation',exact:true}).click();
  const progress=flaggedRow.locator('[data-translation-job-id]');
  await expect(progress).toContainText('1 need attention',{timeout:20000});
  await expect(progress).toContainText('required glossary term');
  await expect(progress).toContainText('The remaining translations are continuing.');
  await expect(progress).toContainText('Translating');
  await progress.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'05-glossary-flag-continues.png')});
  release();
  await expect(progress).toContainText('Needs attention',{timeout:20000});
  await expect(progress).toContainText('1 of 2 drafts saved');
  await expect(progress).not.toContainText('The remaining translations are continuing.');
  assert.equal(app.meta.calls.length,before+3);
  await page.setViewportSize({width:390,height:844});
  await progress.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'06-mobile-validation-result.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors, []);
  console.log('Translation job browser flow passed. Artifacts: ' + artifacts);
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error('Artifacts: ' + artifacts); throw error;
} finally {
  await browser?.close(); for (const close of cleanup.reverse()) await close();
}
