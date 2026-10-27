// SPDX-License-Identifier: Apache-2.0
// Host-owned request/confirmation functions keep identity and approvals out of
// this display component. Repository strings are always rendered as text.
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
};
function styles() {
  if (document.querySelector('link[data-extraction-style]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/extraction.css'; link.dataset.extractionStyle = '';
  document.head.append(link);
}
const action = (request, name, body) => request('/api/actions/' + name, body).then(reply => reply.result);
const button = label => { const el = node('button', label); el.type = 'button'; return el; };

export function extractionProgress({ projectSlug, extractionId, request, onImport }) {
  styles();
  const card = node('article', null, 'extraction-progress'); card.dataset.extractionId = extractionId;
  card.append(node('p', 'SOURCE EXTRACTION', 'extraction-eyebrow'));
  const title = node('h4', 'Checking progress…'); const status = node('p'); status.setAttribute('role', 'status');
  const details = node('div'); const error = node('p', null, 'agent-error'); error.setAttribute('role', 'alert');
  const retry = button('Refresh status');
  const phases = { queued: 'Waiting for the engine', resolving_commit: 'Pinning the source revision', fetching_source: 'Reading selected source files', processing: 'Extracting strings' };
  let timer, busy = false, polls = 0;
  async function update() {
    if (!card.isConnected || busy) return;
    clearTimeout(timer); busy = true; retry.disabled = true; error.textContent = '';
    try {
      const result = await action(request, 'extraction.get', { projectSlug, extractionId });
      if (!card.isConnected) return;
      const job = result.extraction;
      title.textContent = job.importedAt ? 'Source strings imported' : job.status === 'succeeded' ? 'Your strings are ready to review' : ['failed', 'cancelled'].includes(job.status) ? 'Extraction stopped' : 'Hedgeling is reading your source';
      status.textContent = phases[job.phase] || ({ succeeded: 'Extraction complete', failed: 'Extraction failed', cancelled: 'Extraction cancelled' }[job.status]) || 'Processing';
      details.replaceChildren();
      if (job.message) details.append(node('p', job.message));
      if (job.commitSha) details.append(node('p', 'Source commit: ' + job.commitSha, 'extraction-commit'));
      if (result.catalog) {
        details.append(node('p', `${result.catalog.total} source strings · ${job.importedAt ? 'Imported into this project' : 'Nothing has been imported yet'}`));
        const sample = node('ul', null, 'extraction-sample');
        for (const text of result.catalog.sample) sample.append(node('li', text));
        details.append(sample, node('p', `Sample: ${result.catalog.sample.length} of ${result.catalog.total} strings (up to 300 characters each).`, 'extraction-note'));
        if (!job.importedAt && result.catalog.total && onImport) {
          const review = button('Review import'); review.className = 'primary';
          review.addEventListener('click', async () => {
            review.disabled = true; error.textContent = '';
            try { await onImport({ projectSlug, extractionId }); }
            catch (e) { error.textContent = e.message; }
            finally { review.disabled = false; }
          });
          details.append(review);
        }
      }
      if (['queued', 'running'].includes(job.status)) {
        details.append(node('p', 'You can keep working. This confirmed extraction continues if you pause the chat.', 'extraction-note'));
        if (++polls < 120) timer = setTimeout(update, 3000);
        else status.textContent += ' · Select Refresh status to keep checking.';
      }
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; retry.disabled = false; }
  }
  retry.addEventListener('click', () => { polls = 0; void update(); });
  card.addEventListener('extraction-refresh', () => { void update(); });
  card.append(title, status, details, retry, error);
  setTimeout(update, 0);
  return card;
}

export function extractionPanel({ project, request, confirmation, controllerId, onImported = () => {} }) {
  styles();
  const panel = node('details', null, 'workspace-form extraction-panel'); panel.dataset.workspaceAction = 'extraction.start';
  panel.dataset.projectId = project.id;
  panel.append(node('summary', 'Source extraction'));
  const content = node('div'); const review = node('div'); const history = node('div'); const info = node('p'); info.setAttribute('role', 'status');
  panel.append(content, review, history, info);
  let loaded = false, offset = 0;
  async function propose(name, input) {
    const result = await action(request, name, input);
    const proposal = result.proposal;
    const close = async () => { await request(`/api/agent/proposals/${proposal.id}/reject`, {}); review.replaceChildren(); content.hidden = false; };
    const card = confirmation(proposal, {
      edit: close, cancel: close,
      confirm: async () => {
        const saved = await request(`/api/agent/proposals/${proposal.id}/confirm`, { fingerprint: proposal.fingerprint, controllerId });
        review.replaceChildren(node('p', saved.result.import ? 'Your source strings are imported. Open the project to inspect them.' : 'Extraction started. Follow its progress below.', 'extraction-success'));
        content.hidden = false;
        await jobs(true);
        if (saved.result.import) await onImported();
      },
    });
    content.hidden = true; review.replaceChildren(card); card.scrollIntoView({ block: 'nearest' }); card.querySelector('h3')?.focus();
  }
  const more = button('Load more extractions');
  async function jobs(reset = false) {
    if (reset) { offset = 0; history.replaceChildren(); }
    const page = await action(request, 'extraction.jobs', { projectSlug: project.slug, limit: 5, offset });
    for (const job of page.extractions) history.append(extractionProgress({ projectSlug: project.slug, extractionId: job.id, request,
      onImport: input => propose('extraction.import', input) }));
    offset = page.nextOffset; more.hidden = offset == null; history.append(more);
  }
  more.addEventListener('click', async () => { more.disabled = true; try { await jobs(); } catch (e) { info.textContent = e.message; } finally { more.disabled = false; } });
  panel.addEventListener('toggle', async () => {
    if (!panel.open || loaded) return;
    loaded = true; info.textContent = 'Loading connected sources…';
    try {
      const result = await action(request, 'extraction.connections', { projectSlug: project.slug });
      if (!result.connections.length) { content.append(node('p', 'No repository is connected to this project yet. A workspace operator can connect an allowed repository.')); info.textContent = ''; return; }
      content.append(node('p', 'Bring source strings into this project from a connected repository. You’ll approve extraction first, then review the import.'));
      const form = document.createElement('form'); const fields = document.createElement('fieldset'); fields.className = 'workspace-form-fields';
      const select = document.createElement('select'); select.name = 'connectionId'; select.setAttribute('aria-label', 'Connected repository');
      for (const connection of result.connections) select.append(new Option(connection.owner + '/' + connection.repository, connection.connectionId));
      const ref = document.createElement('input'); ref.name = 'ref'; ref.required = true; ref.maxLength = 200;
      const roots = document.createElement('textarea'); roots.name = 'scanRoots'; roots.required = true; roots.rows = 3; roots.maxLength = 10240;
      for (const [label, control] of [['Connected repository', select], ['Branch, tag or commit', ref], ['Source paths (one per line)', roots]]) { const field = node('label', label); field.append(control); fields.append(field); }
      const allowed = node('p', null, 'extraction-note');
      const selection = () => { const c = result.connections.find(c => c.connectionId === select.value); ref.value = c.defaultRef; roots.value = c.allowedRoots.join('\n'); allowed.textContent = 'Allowed roots: ' + c.allowedRoots.join(', '); };
      select.addEventListener('change', selection); selection();
      const preview = node('button', 'Review extraction', 'primary'); preview.type = 'submit';
      form.append(fields, allowed, preview); content.append(form);
      form.addEventListener('submit', async event => {
        event.preventDefault(); preview.disabled = true; info.textContent = '';
        try { await propose('extraction.start', { projectSlug: project.slug, connectionId: select.value, ref: ref.value.trim(), scanRoots: roots.value.split('\n').map(s => s.trim()).filter(Boolean) }); }
        catch (e) { info.textContent = e.message; }
        finally { preview.disabled = false; }
      });
      await jobs(true); info.textContent = '';
    } catch (e) { info.textContent = e.message; loaded = false; }
  });
  return panel;
}
