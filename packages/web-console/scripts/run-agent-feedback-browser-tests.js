import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { localConsole } from '../test-support/local-console.mjs';

const app = await localConsole(process.env.TEST_DATABASE_URL);
const artifacts = process.env.HEDGELING_FEEDBACK_ARTIFACTS || join(tmpdir(), 'hedgeling-beta-feedback');
await fs.mkdir(artifacts, { recursive: true });
let browser, page;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.HEDGELING_E2E_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const split = app.cookie.indexOf('=');
  await context.addCookies([{ name: app.cookie.slice(0, split), value: app.cookie.slice(split + 1), url: app.origin }]);
  await context.addInitScript(() => {
    window.chimes = 0;
    window.AudioContext = class {
      state = 'running'; currentTime = 0; destination = {};
      resume() { return Promise.resolve(); }
      createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() { window.chimes++; }, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.origin);
  const shell = page.locator('#hedgelingAgent');
  await expect(shell.locator('#agentInput')).toBeEnabled();
  await expect(shell.locator('#agentWidth')).toHaveCount(0);
  await expect(shell).not.toContainText('to be continued');
  const run = await page.evaluate(() => sessionStorage.getItem(Object.keys(sessionStorage).find(k => k.startsWith('hedgeling.agent.run.'))));
  const emit = async (kind, data) => app.database.query('insert into agent_events(run_id,kind,data) values($1,$2,$3)', [run, kind, data]);
  await emit('message', { role: 'user', text: 'Translate this game, then help me deliver a PR.' });
  await emit('state', { status: 'planning' });
  for (const tool of ['console_list_projects', 'console_get_job_delivery_options']) {
    await emit('activity', { tool, status: 'working', label: tool === 'console_list_projects' ? 'Finding your project' : 'Checking delivery readiness' });
    await emit('activity', { tool, status: 'complete', label: 'Workspace information loaded' });
  }
  await emit('message', { role: 'assistant', text: '## Translation complete\n\nYour drafts are saved.\n\n## Before opening a PR\n\n- Connect GitHub\n- Verify your reviewed translations' });
  await emit('state', { status: 'awaiting_input' });
  await expect(shell.locator('.agent-activity-group summary')).toHaveText('Activity complete · 2 steps');
  await expect(shell.locator('.agent-activity')).toHaveCount(2);
  await expect(shell.locator('.agent-activity').first()).not.toBeVisible();
  await shell.locator('.agent-activity-group summary').click();
  await expect(shell.getByText('Finding your project', { exact: true })).toBeVisible();
  await shell.locator('.agent-activity-group summary').click();
  await expect(shell.locator('.agent-message-user .agent-message-header')).toContainText('You');
  await expect(shell.locator('.agent-message-assistant h3')).toHaveCount(2);
  await expect(shell.locator('time').first()).toHaveAttribute('datetime', /T/);
  assert.equal(await page.evaluate(() => window.chimes), 0);
  await page.screenshot({ path: `${artifacts}/chat-light.png` });
  await shell.locator('[data-theme-preference]').selectOption('dark');
  await page.screenshot({ path: `${artifacts}/chat-dark.png` });
  await shell.getByRole('button', { name: 'Side panel', exact: true }).click();
  const handle = shell.getByRole('separator', { name: 'Resize chat panel' });
  await expect(handle).toBeVisible(); const initial = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(Number(await handle.getAttribute('aria-valuenow')), initial + 24);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 6, box.y + 150); await page.mouse.down(); await page.mouse.move(box.x - 100, box.y + 150); await page.mouse.up();
  assert.ok(Number(await handle.getAttribute('aria-valuenow')) > initial + 100);
  assert.equal(await page.locator('body').evaluate(n => n.classList.contains('agent-resizing')), false);
  await shell.locator('#agentSound').click();
  await expect(shell.locator('#agentSound')).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await page.evaluate(() => window.chimes), 1);
  await shell.getByRole('button', { name: 'Minimize chat', exact: true }).click();
  // Only a new reply/approval boundary pings; tool activity stays quiet.
  await emit('state', { status: 'planning' });
  await emit('activity', { tool: 'console_list_projects', status: 'working', label: 'Checking again' });
  await expect(shell.locator('.agent-activity-group summary')).toContainText('Checking again');
  assert.equal(await page.evaluate(() => window.chimes), 1);
  await page.waitForTimeout(1600);
  await emit('message', { role: 'assistant', text: 'Your next step is ready.' });
  await emit('state', { status: 'awaiting_input' });
  await expect(page.locator('.agent-notifications')).toBeVisible();
  await expect(page.locator('.agent-unread')).toHaveText('1');
  await expect.poll(() => page.evaluate(() => window.chimes)).toBe(2);
  await page.locator('.agent-notifications').getByRole('button', { name: 'View conversation' }).click();
  await expect(shell).toBeVisible(); await expect(page.locator('.agent-unread')).toBeHidden();
  await page.screenshot({ path: `${artifacts}/resized-panel.png` });
  const savedWidth = await handle.getAttribute('aria-valuenow');
  await page.reload(); await expect(shell.locator('#agentInput')).toBeEnabled();
  await expect(shell.getByRole('separator')).toHaveAttribute('aria-valuenow', savedWidth);
  assert.equal(await page.evaluate(() => window.chimes), 0, 'Replayed history must not play sounds');
  await expect(page.locator('.agent-notifications')).toBeHidden();
  await shell.locator('#agentSound').click();
  // A slow history restore must honor the saved minimized layout immediately.
  await shell.getByRole('button', { name: 'Minimize chat', exact: true }).click();
  let releaseHistory;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  const historyRoute = async route => { await historyGate; await route.continue(); };
  await page.route('**/api/agent/runs/*', historyRoute, { times: 1 });
  const restoring = page.waitForRequest(request => new URL(request.url()).pathname === `/api/agent/runs/${run}`);
  try {
    await page.reload(); await restoring;
    await expect(shell).toHaveAttribute('data-mode', 'minimized');
    await expect(shell).toBeHidden();
    await expect(page.getByRole('button', { name: /Open Hedgeling assistant/ })).toBeVisible();
  } finally { releaseHistory(); }
  await page.getByRole('button', { name: /Open Hedgeling assistant/ }).click();
  await expect(shell).toHaveAttribute('data-mode', 'panel');
  await expect(shell.locator('#agentInput')).toBeEnabled();
  // Old repository file events must remain invisible when replayed.
  await emit('files', { files: [{ path: 'src/Game.tsx', bytes: 120 }] });
  await emit('github_connection', { reason: 'pr_delivery' });
  await expect(shell.locator('.github-connection-card')).toBeVisible();
  await expect(shell.locator('.document-file-card')).toHaveCount(0);
  await expect(shell.locator('.github-connection-card')).toContainText('GitHub sign-in is not configured');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(shell).toHaveAttribute('data-mode', 'overlay');
  await expect(shell.getByRole('separator')).toBeHidden();
  assert.ok(await shell.evaluate(n => n.scrollWidth <= n.clientWidth + 1), 'Mobile chat must not overflow horizontally');
  await page.screenshot({ path: `${artifacts}/chat-mobile.png` });
  // Synthetic delivery responses exercise the actual form without calling GitHub.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shell.getByRole('button', { name: 'Minimize chat', exact: true }).click();
  await page.evaluate(async () => {
    const { translationJobControls } = await import('/translation-jobs.js');
    const root = document.createElement('section'); root.id = 'testDelivery'; root.className = 'workspace-view';
    Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '200', overflow: 'auto', background: 'var(--background-pane)' });
    const job = { id: '00000000-0000-4000-8000-000000000001', name: 'Synthetic game translations', projectSlug: 'synthetic-game',
      status: 'awaiting_review', canDeliver: true, steps: ['machine_translation', 'review'], targetLocales: ['fr', 'ru'],
      progress: { succeeded: 4 }, coverage: { total: 4, saved: 4, missing: 0, verified: 1 }, errors: [], workflow: 'AI Translation → Review' };
    window.githubReady = false;
    const request = async (path, body) => {
      if (path === '/api/github/status') return { configured: true, connected: window.githubReady, login: window.githubReady ? 'tester' : null };
      if (path === '/api/github/start') return { url: 'https://github.com/login/oauth/authorize?client_id=synthetic-test' };
      if (path === '/api/actions/localization_job.status') return { result: { job } };
      if (path === '/api/actions/localization_job.delivery_options') return { result: {
        connections: [{ connectionId: 'old-demo', owner: 'example', repository: 'old', defaultRef: 'main' }, { connectionId: 'latest-game', owner: 'example', repository: 'game', defaultRef: 'game' }],
        imports: [{ id: '00000000-0000-4000-8000-000000000002', connectionId: 'latest-game', ref: 'abc123', importedAt: new Date().toISOString() }], pullRequests: [],
        destination: body.connectionId ? { baseBranch: 'game', bundlePaths: ['public/hedgeling-bundle.json'], sourceMapPaths: ['public/hedgeling-source-key-map.json'], githubWriteAccess: window.githubReady } : null,
      } };
      throw new Error(`Unexpected synthetic request: ${path}`);
    };
    root.append(translationJobControls({ job, request })); document.body.append(root);
  });
  const delivery = page.locator('#testDelivery .job-delivery');
  await delivery.locator(':scope > summary').click();
  await expect(delivery.getByLabel('Repository', { exact: true })).toHaveValue('latest-game');
  await expect(delivery.locator('.delivery-readiness')).toContainText('1 of 4 verified');
  await expect(delivery.getByRole('button', { name: 'Preview translation PR' })).toBeDisabled();
  await expect(delivery.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeEnabled();
  await expect(delivery.getByRole('link', { name: 'Open translations to verify' })).toHaveAttribute('href', '/?project=synthetic-game#review');
  await page.screenshot({ path: `${artifacts}/github-readiness.png`, fullPage: true });
  await page.evaluate(() => { window.githubReady = true; });
  await delivery.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(delivery).toContainText('Account connected: tester');
  await expect(delivery.getByRole('button', { name: 'Preview translation PR' })).toBeEnabled();
  await page.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Synthetic GitHub authorization screen</p>' }));
  await delivery.getByRole('button', { name: 'Reconnect GitHub', exact: true }).click();
  await expect(page).toHaveURL('https://github.com/login/oauth/authorize?client_id=synthetic-test');
  assert.deepEqual(errors, []);
  console.log('PASS: grouped activity, message structure, timestamps, sound preference, unread notifications, replay, drag/keyboard resizing, GitHub authorization handoff, delivery readiness/review counts, latest extraction selection, and mobile layout.');
} catch (e) { if (page) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {}); throw e; }
finally { await browser?.close(); await app.close(); }
