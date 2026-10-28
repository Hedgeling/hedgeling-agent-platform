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

export function extractionProgress({ projectSlug, extractionId, request, onImport, onTuneApply }) {
  styles();
  const card = node('article', null, 'extraction-progress'); card.dataset.extractionId = extractionId;
  card.append(node('p', 'SOURCE EXTRACTION', 'extraction-eyebrow'));
  const title = node('h4', 'Checking progress…'); const status = node('p'); status.setAttribute('role', 'status');
  const details = node('div'); const error = node('p', null, 'agent-error'); error.setAttribute('role', 'alert');
  const retry = button('Refresh status');
  const phases = { queued: 'Waiting for the engine', resolving_commit: 'Pinning the source revision', fetching_source: 'Reading selected source files', processing: 'Processing source', awaiting_model: 'Classifying candidate strings with your selected provider' };
  let timer, busy = false, polls = 0;
  async function update() {
    if (!card.isConnected || busy) return;
    clearTimeout(timer); busy = true; retry.disabled = true; error.textContent = '';
    try {
      const result = await action(request, 'extraction.get', { projectSlug, extractionId });
      if (!card.isConnected) return;
      const job = result.extraction;
      title.textContent = ['tune', 'tune-llm'].includes(job.operation) ? (job.status === 'succeeded' ? 'Your tuning preview is ready' : 'Hedgeling is checking extraction settings') : job.importedAt ? 'Source strings imported' : job.status === 'succeeded' ? 'Your strings are ready to review' : ['failed', 'cancelled'].includes(job.status) ? 'Extraction stopped' : 'Hedgeling is reading your source';
      status.textContent = phases[job.phase] || ({ succeeded: 'Extraction complete', failed: 'Extraction failed', cancelled: 'Extraction cancelled' }[job.status]) || 'Processing';
      details.replaceChildren();
      if (job.message) details.append(node('p', job.message));
      if (job.commitSha) details.append(node('p', 'Source commit: ' + job.commitSha, 'extraction-commit'));
      if (result.modelUsage) { const m = result.modelUsage; details.append(node('p', `${m.provider} · ${m.model} · ${m.calls} of ${m.limits.calls} possible model requests · ${m.totalTokens == null ? 'Token usage pending or unavailable; see Billing & usage' : `${m.usageEstimated ? 'Estimated ' : ''}${m.totalTokens} tokens`}`)); }
      if (result.tuning) {
        const t = result.tuning;
        if (t.mode === 'llm') details.append(node('p', `${t.classifiedCount} candidate texts classified (up to ${t.maximumItems}); ${t.llmCalls} model requests. This is a bounded sample, not a full catalog review.`));
        status.textContent = 'Tuning preview complete · project settings unchanged';
        details.append(node('p', `${t.before.strings} → ${t.after.strings} strings · ${t.before.diagnostics} → ${t.after.diagnostics} diagnostics`));
        details.append(node('p', t.acceptedEdits.length ? `${t.acceptedEdits.length} accepted setting changes. Review them before saving.` : 'The tuner found no safe automatic changes. You can still save this configuration for the project.', 'extraction-note'));
        const edits = node('ul'); for (const edit of t.acceptedEdits) edits.append(node('li', `${edit.field}: ${edit.value}`)); details.append(edits);
        if (onTuneApply) {
          const save = button('Review settings and re-extract'); save.className = 'primary';
          save.addEventListener('click', async () => { save.disabled = true; try { await onTuneApply({ projectSlug, extractionId }); } catch(e) { error.textContent = e.message; } finally { save.disabled = false; } });
          details.append(save);
        }
      }
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
        review.replaceChildren(node('p', saved.result.import ? 'Your source strings are imported. Open the project to inspect them.' : saved.result.settingsSaved ? 'Settings saved. Re-extraction started; import still needs your approval.' : ['tune', 'tune-llm'].includes(saved.result.extraction?.operation) ? 'Tuning preview started. Project settings have not changed.' : 'Extraction started. Follow its progress below.', 'extraction-success'));
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
      onImport: input => propose('extraction.import', input), onTuneApply: input => propose('extraction.tuning.apply', input) }));
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
      const configPath = node('input'); configPath.value = '.hedgeling/extract.config.json'; configPath.maxLength = 512; configPath.name = 'configPath';
      const configLabel = node('label', 'Extraction config path'); configLabel.append(configPath); fields.append(configLabel);
      const mode = node('select'); mode.name = 'tuningMode'; mode.append(new Option('Deterministic — no model calls', 'deterministic'), new Option('LLM-assisted — organization provider key', 'llm'));
      const modeLabel = node('label', 'Tuning method'); modeLabel.append(mode); fields.append(modeLabel);
      const allowed = node('p', null, 'extraction-note');
      const selection = () => { const c = result.connections.find(c => c.connectionId === select.value); ref.value = c.defaultRef; roots.value = c.allowedRoots.join('\n'); allowed.textContent = 'Allowed roots: ' + c.allowedRoots.join(', '); };
      select.addEventListener('change', selection); selection();
      const preview = node('button', 'Review extraction', 'primary'); preview.type = 'submit';
      const inspect = button('View extraction config'), tune = button('Review tuning run'), download = button('Download saved config');
      const configView = node('pre', null, 'extraction-config'); configView.tabIndex = 0;
      const configSelection = () => ({ projectSlug: project.slug, connectionId: select.value, ref: ref.value.trim(), configPath: configPath.value.trim() });
      const perform = (control, work) => control.addEventListener('click', async () => { control.disabled = true; info.textContent = ''; try { await work(); } catch(e) { info.textContent = e.message; } finally { control.disabled = false; } });
      perform(inspect, async () => { const result = await action(request, 'extraction.config', configSelection()); configView.textContent = JSON.stringify(result.effectiveSettings, null, 2); info.textContent = `Using ${result.source} settings. Repository config ${result.repository.found ? 'found' : 'not found'} at ${result.repository.commitSha}. ${result.repository.ignoredFields.length ? 'Unsupported fields omitted: ' + result.repository.ignoredFields.join(', ') : ''}`; });
      perform(tune, () => propose('extraction.tune', { ...configSelection(), mode: mode.value, scanRoots: roots.value.split('\n').map(s => s.trim()).filter(Boolean) }));
      perform(download, async () => { const result = await action(request, 'extraction.settings', { projectSlug: project.slug, connectionId: select.value }); if (!result.download) { info.textContent = 'No project settings saved yet. Review a tuning run first.'; return; } const url = URL.createObjectURL(new Blob([result.download.content],{type:'application/json'})); const a = node('a'); a.href = url; a.download = result.download.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
      form.append(fields, allowed, preview, inspect, tune, download); content.append(form, configView);
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
