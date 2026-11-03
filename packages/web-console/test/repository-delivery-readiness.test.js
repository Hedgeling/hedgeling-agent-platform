import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONSOLE_ACTIONS, validateActionInput } from '@hedgeling/api-contract';
import { createRepositories } from '../src/hackathon-engine/repositories.js';
import { githubIdentity } from '../src/hackathon-engine/github-identity.js';
import { agentInstructions } from '../src/agent-skills.js';

const commitSha = 'a'.repeat(40);
const auth = { user: { id: 'judge' }, principalType: 'user' };
const project = { id: 'project', slug: 'playground', organizationId: 'judges' };
const input = { projectSlug: project.slug, url: 'https://github.com/example/playground' };
const bundle = 'public/hedgeling-bundle.json', map = 'public/hedgeling-source-key-map.json';
const forbidden = () => assert.fail('Readiness must not download source, call a model or write anything.');

function fixture({ paths = [], token = null, canPush = false, configured = true, savedConnected = Boolean(token), branchError, branchSha = commitSha, denied = false, treeError } = {}) {
  const calls = [];
  const github = {
    async resolve(url, getToken) {
      calls.push('resolve'); assert.equal(url, input.url); assert.equal(await getToken(), token);
      return { id: 123, owner: 'example', repository: 'playground', url, defaultRef: 'main', visibility: 'public', canPush, token };
    },
    async tree(_repo, ref) { calls.push('tree'); if (treeError) throw treeError; assert.equal(typeof ref, 'string'); return { commitSha, files: paths.map(path => ({ path, size: 100 })) }; },
    async request(path, givenToken, options) {
      calls.push('branch'); assert.match(path, /^\/repos\/example\/playground\/branches\//); assert.equal(options, undefined); assert.equal(givenToken, token);
      if (branchError) throw branchError;
      return { commit: { sha: branchSha } };
    },
    file: forbidden, snapshot: forbidden,
  };
  const api = createRepositories({
    database: { async query(sql, args) {
      calls.push('project'); assert.match(sql, /^select p.id/); assert.deepEqual(args, [project.slug]);
      return { rows: [project] };
    } },
    github,
    identity: {
      async token(actor) { calls.push('token'); assert.equal(actor, auth); return token; },
      async status(actor) { assert.equal(actor, auth); return { configured, connected: savedConnected, login: savedConnected ? 'test-judge' : null, installationUrl: null }; },
    },
    async authorize(actor, p, write) {
      calls.push('authorize'); assert.equal(actor, auth); assert.equal(p, project); assert.equal(write, false);
      if (denied) throw Object.assign(new Error('Denied'), { code: 'repository_access_denied' });
    },
    engine: forbidden, fingerprint: forbidden,
  });
  return { calls, read: (override = {}, scope = { organizationId: 'judges' }) => api.read('repositories.delivery_readiness', { ...input, ...override }, auth, scope) };
}

test('a new public repository gets actionable setup guidance before any job exists', async () => {
  const f = fixture({ paths: ['src/App.tsx'] });
  const result = await f.read(), r = result.readiness;
  assert.equal(r.status, 'setup_required');
  assert.equal(r.checks.githubAccount, 'not_connected');
  assert.equal(r.checks.repositoryPushAccess, 'not_checked');
  assert.equal(r.checks.runtimeFiles, 'missing');
  assert.equal(r.baseBranch, 'main'); assert.equal(r.commitSha, commitSha);
  assert.equal(r.blocksExtractionOrTranslation, false);
  assert.equal(r.choices.length, 2);
  assert.match(r.setupSteps.find(s => s.code === 'connect_github').instructions.join(' '), /Connect or change a repository/);
  const setup = r.setupSteps.find(s => s.code === 'runtime_setup').instructions.join(' ');
  assert.match(setup, /does not create the app integration/); assert.match(setup, /Empty JSON files alone/);
  assert.match(setup, /extract\/import/);
  assert.equal(r.setupSteps.find(s => s.code === 'app_access').installationUrl, null);
  assert.equal(result.uiTarget.projectSlug, project.slug);
  assert.deepEqual(f.calls, ['project', 'authorize', 'resolve', 'token', 'tree', 'branch']);
  assert(!JSON.stringify(result).includes('src/App.tsx'), 'only delivery paths enter chat');
});

test('existing file names and push permission never assert App permissions or working translations', async () => {
  const r = (await fixture({ paths: [bundle, map], token: 'synthetic-private-token', canPush: true }).read()).readiness;
  assert.equal(r.status, 'checks_remaining'); assert.equal(r.checks.runtimeFiles, 'found');
  assert.equal(r.checks.repositoryPushAccess, 'available');
  for (const check of ['runtimeFormat', 'appPermissions', 'appIntegration']) assert.equal(r.checks[check], 'not_checked');
  assert(!r.setupSteps.some(s => s.code === 'runtime_setup'));
  assert(r.setupSteps.some(s => s.code === 'verify_runtime'));
  assert(!JSON.stringify(r).includes('synthetic-private-token'));
  assert.deepEqual(r.files.bundlePaths, [bundle]); assert.deepEqual(r.files.sourceMapPaths, [map]);
});

test('both runtime file types are needed; a lookalike name does not count', async () => {
  for (const paths of [[bundle], [map], ['old-hedgeling-bundle.json', map]]) {
    const r = (await fixture({ paths, token: 'synthetic', canPush: true }).read()).readiness;
    assert.equal(r.checks.runtimeFiles, 'missing'); assert.equal(r.status, 'setup_required');
  }
});

test('read-only users get a destination/fork handoff and stale authorization is not called connected', async () => {
  const r = (await fixture({ paths: [bundle, map], token: 'synthetic' }).read()).readiness;
  assert.equal(r.checks.repositoryPushAccess, 'unavailable');
  assert.match(r.setupSteps.find(s => s.code === 'repository_write_access').instructions.join(' '), /connect and extract from that destination before translating/);
  const stale = (await fixture({ savedConnected: true }).read()).readiness;
  assert.equal(stale.account.login, 'test-judge'); assert.equal(stale.checks.githubAccount, 'not_connected');
  assert(stale.setupSteps.some(s => s.code === 'connect_github'));
  const unconfigured = (await fixture({ configured: false }).read()).readiness;
  assert.equal(unconfigured.checks.githubAccount, 'not_configured');
  assert(unconfigured.setupSteps.some(s => s.code === 'github_configuration'));
});

test('a commit or tag is not a PR base and a moving branch is reported explicitly', async () => {
  const r = (await fixture({ branchError: { upstreamStatus: 404 } }).read({ baseBranch: commitSha })).readiness;
  assert.equal(r.checks.baseBranch, 'not_a_branch');
  assert.match(r.setupSteps.find(s => s.code === 'base_branch').instructions[0], /named branch/);
  const changed = (await fixture({ branchSha: 'b'.repeat(40) }).read()).readiness;
  assert.equal(changed.checks.baseBranch, 'changed_during_check');
});

test('access failures and incomplete repository discovery are not reported as missing files', async () => {
  for (const options of [{ branchError: { upstreamStatus: 403 } }, { branchError: { code: 'github_rate_limit' } }, { treeError: { code: 'repository_tree_limit' } }]) {
    const error = options.branchError || options.treeError;
    await assert.rejects(fixture(options).read(), caught => caught === error);
  }
});

test('large repositories produce bounded path lists without unrelated source paths or content', async () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `apps/${i}/hedgeling-bundle.json`);
  paths.push(...Array.from({ length: 1000 }, (_, i) => `apps/${i}/hedgeling-source-key-map.json`));
  const r = (await fixture({ paths, token: 'synthetic', canPush: true }).read()).readiness;
  assert.equal(r.files.bundleCount, 1000); assert.equal(r.files.sourceMapCount, 1000);
  assert.equal(r.files.bundlePaths.length, 12); assert.equal(r.files.sourceMapPaths.length, 12);
  assert.equal(r.files.truncated, true);
  assert(Buffer.byteLength(JSON.stringify(r)) < 10000);
});

test('project access and conversation scope are enforced before GitHub access', async () => {
  const denied = fixture({ denied: true });
  await assert.rejects(denied.read(), { code: 'repository_access_denied' });
  assert.deepEqual(denied.calls, ['project', 'authorize']);
  const wrongScope = fixture();
  await assert.rejects(wrongScope.read({}, { organizationId: 'other' }), { code: 'agent_scope_mismatch' });
  assert.deepEqual(wrongScope.calls, ['project']);
});

test('installation links come only from a valid configured app slug, never credentials or a guessed app', async () => {
  for (const appSlug of [undefined, 'synthetic-test-app', 'other/app', 'app?token=secret', '-app', 'x'.repeat(101)]) {
    const identity = githubIdentity({ database: { query: async () => ({ rows: [] }) },
      configuration: () => ({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret', redirectUri: 'https://console.example.com/api/github/callback', appSlug }) });
    const status = await identity.status(auth);
    assert.equal(status.installationUrl, appSlug === 'synthetic-test-app' ? 'https://github.com/apps/synthetic-test-app/installations/new' : null);
    assert(!JSON.stringify(status).includes('synthetic-secret'));
  }
});

test('shared tool contract is read-only, job-independent and available in the agent onboarding instructions', async () => {
  const action = CONSOLE_ACTIONS.find(a => a.name === 'repositories.delivery_readiness');
  assert.equal(action.readOnly, true); assert.equal(action.toolName, 'console_check_repository_delivery');
  assert.equal(validateActionInput(action, input), null);
  assert.match(validateActionInput(action, { ...input, jobId: 'invented' }), /Invalid action input/);
  assert.match(validateActionInput(action, { projectSlug: project.slug }), /Invalid action input/);
  const instructions = agentInstructions('judges');
  assert.match(instructions, /before proposing paid enrichment or translation/);
  assert.match(instructions, /give numbered setup instructions directly in chat/);
  assert.match(instructions, /Respect an explicit translation-only choice/);
  for (const name of ['repository-actions.js', 'translation-job-actions.js', 'job-delivery-actions.js']) {
    assert.equal(await readFile(new URL(`../../api-contract/${name}`, import.meta.url), 'utf8'),
      await readFile(new URL(`../src/hackathon-engine/${name}`, import.meta.url), 'utf8'));
  }
});
