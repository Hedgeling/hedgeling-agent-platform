// SPDX-License-Identifier: Apache-2.0
// Metadata only: never send repository source, translation values or tokens to chat.
const PATH_LIMIT = 12;
const pathsFor = (files, name) => files.filter(file => file.path.split('/').at(-1) === name).map(file => file.path);

export async function repositoryDeliveryReadiness({ github, repo, baseBranch, account }) {
  const tree = await github.tree(repo, baseBranch);
  let branch = null;
  try {
    branch = await github.request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repository)}/branches/${encodeURIComponent(baseBranch)}`, repo.token);
  } catch (error) {
    if (error.upstreamStatus !== 404) throw error;
  }
  const branchStatus = branch === null ? 'not_a_branch' : branch.commit?.sha === tree.commitSha ? 'confirmed' : 'changed_during_check';
  const bundles = pathsFor(tree.files, 'hedgeling-bundle.json');
  const maps = pathsFor(tree.files, 'hedgeling-source-key-map.json');
  const connected = Boolean(repo.token);
  const missingFiles = !bundles.length || !maps.length;
  const setupSteps = [];
  if (!account.configured) setupSteps.push({ code: 'github_configuration', instructions: [
    'Ask the workspace operator to configure GitHub sign-in for this console, including its callback URL. Do not paste credentials into chat.'
  ] });
  if (!connected) setupSteps.push({ code: 'connect_github', instructions: [
    'In Projects, open this project and expand Connect or change a repository. Click Connect GitHub and complete authorization with your own GitHub account.',
    'After returning, confirm the displayed GitHub username is yours. Public extraction can work without this connection; PR creation cannot.'
  ] });
  if (connected && !repo.canPush) setupSteps.push({ code: 'repository_write_access', instructions: [
    'Use a test repository you own, or ask its owner to give your connected GitHub account Write access.',
    'If you use a fork or another repository, connect and extract from that destination before translating. Do not switch the PR destination after extraction.'
  ] });
  setupSteps.push({ code: 'app_access', instructions: [
    'Install the Hedgeling GitHub App on the account that owns the repository and select this repository. If it is already installed, use Manage GitHub App access, then Configure and Repository access.',
    'Approve Contents: read and write and Pull requests: read and write. An organization owner may need to approve installation or changed permissions. Reconnect GitHub in Hedgeling after permission changes.',
    'Account authorization, repository Write access and App installation are separate requirements. This read-only check does not verify App write permissions.'
  ], manageUrl: 'https://github.com/settings/installations', installationUrl: account.installationUrl || null });
  if (branchStatus !== 'confirmed') setupSteps.push({ code: 'base_branch', instructions: [
    branchStatus === 'not_a_branch' ? 'Choose an existing named branch as the PR base; a commit SHA or tag cannot be a PR base.' : 'The branch changed during this check. Check it again before proceeding.'
  ] });
  if (missingFiles) setupSteps.push({ code: 'runtime_setup', instructions: [
    'This PR workflow updates existing schemaVersion 1 Hedgeling translation bundles and source-key maps; it does not create the app integration.',
    'Ask your developer or coding agent to integrate the supported Hedgeling runtime, commit hedgeling-bundle.json and hedgeling-source-key-map.json at the paths your app loads, and provide a way to select a language.',
    'The bundle stores translations by locale and runtime key; the map links source text and context to those keys. Empty JSON files alone do not localize an app. Do not replace an existing localization system or invent runtime keys or package installation commands.',
    'After setup is merged into the chosen base branch, re-check delivery and extract/import that current branch before preparing the PR. Existing saved translations are preserved by import.'
  ] });
  setupSteps.push({ code: 'verify_runtime', instructions: [
    'Have the developer confirm which bundle/map files the app actually loads and test switching languages. File names alone do not prove compatible contents or runtime integration.',
    'This early check does not validate file contents, translation coverage or extraction freshness. Delivery checks those inputs again when preparing the PR; a separate human confirmation creates it. It does not merge or deploy.'
  ] });
  return {
    status: !account.configured || !connected || !repo.canPush || missingFiles || branchStatus !== 'confirmed' ? 'setup_required' : 'checks_remaining',
    baseBranch, commitSha: tree.commitSha,
    checks: { githubAccount: !account.configured ? 'not_configured' : connected ? 'connected' : 'not_connected',
      repositoryPushAccess: connected ? repo.canPush ? 'available' : 'unavailable' : 'not_checked', baseBranch: branchStatus,
      runtimeFiles: missingFiles ? 'missing' : 'found', runtimeFormat: 'not_checked', appPermissions: 'not_checked', appIntegration: 'not_checked' },
    account: { login: account.login || null },
    files: { bundlePaths: bundles.slice(0, PATH_LIMIT), sourceMapPaths: maps.slice(0, PATH_LIMIT),
      bundleCount: bundles.length, sourceMapCount: maps.length, truncated: bundles.length > PATH_LIMIT || maps.length > PATH_LIMIT },
    setupSteps,
    choices: ['Set up delivery first for an end-to-end run.', 'Continue extraction and translation only; set up PR delivery later.'],
    blocksExtractionOrTranslation: false,
  };
}
