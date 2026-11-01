const node = (tag, text = '') => { const el = document.createElement(tag); el.textContent = text; return el; };
export function githubConnectionCard({ request, onChanged = () => {} }) {
  const root = node('section'); root.className = 'github-connection-card'; root.setAttribute('aria-label', 'GitHub connection');
  const title = node('h4', 'Connect GitHub to deliver translations');
  const status = node('p'); status.setAttribute('role', 'status');
  const intro = node('p', 'Public repositories can be extracted without signing in. Opening a translation PR also needs your GitHub account and the App’s write permissions.');
  const actions = node('div'); actions.className = 'github-connection-actions';
  const connect = node('button', 'Connect GitHub'), refresh = node('button', 'Check connection'); connect.type = refresh.type = 'button';
  const manage = node('a', 'Manage GitHub App access ↗'); manage.href = 'https://github.com/settings/installations'; manage.target = '_blank'; manage.rel = 'noopener noreferrer';
  const help = node('details'), summary = node('summary', 'What access does the App need?'), steps = node('ol');
  for (const text of ['Select the repository in the Hedgeling App installation. For an organization repository, its owner may need to approve access in organization settings.', 'Approve Contents: read and write, and Pull requests: read and write. Then reconnect GitHub here if permissions changed.', 'Use a GitHub account with push access to the repository. A connected account alone does not confirm repository write access.']) steps.append(node('li', text));
  help.append(summary, steps);
  const error = node('p'); error.className = 'agent-error'; error.setAttribute('role', 'alert');
  actions.append(connect, manage, refresh); root.append(title, intro, status, actions, help, error);
  async function load() {
    refresh.disabled = true; error.textContent = '';
    try {
      const state = await request('/api/github/status'); connect.disabled = !state.configured;
      connect.textContent = state.connected ? 'Reconnect GitHub' : 'Connect GitHub';
      status.textContent = !state.configured ? 'GitHub sign-in is not configured on this console. The operator needs to configure the GitHub App client and callback.'
        : state.connected ? `Account connected: ${state.login}. Repository access is checked separately below.`
          : state.login ? 'Your GitHub connection expired. Reconnect to prepare a PR.' : 'Your GitHub account is not connected.';
    } catch (e) { error.textContent = e.message; } finally { refresh.disabled = false; }
  }
  connect.onclick = async () => {
    connect.disabled = true; error.textContent = '';
    try { const result = await request('/api/github/start', {}); location.assign(result.url); }
    catch (e) { error.textContent = e.message; connect.disabled = false; }
  };
  refresh.onclick = async () => { await load(); await onChanged(); };
  return { root, refresh: load };
}
