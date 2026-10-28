// SPDX-License-Identifier: Apache-2.0
const node = (tag, text = '', className = '') => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
const names = { draft: 'Draft', queued: 'Queued', running: 'Translating', awaiting_review: 'Drafts ready for review', needs_attention: 'Needs attention', canceled: 'Stopped' };

// Progress uses authenticated reads, never additional model turns.
export function translationJobProgress({ jobId, request, onStop = null }) {
  const card = node('section', '', 'translation-job-progress'); card.dataset.translationJobId = jobId;
  card.setAttribute('aria-label', 'Translation job progress');
  const title = node('h4', 'Translation job'), status = node('p', 'Checking progress…'), detail = node('p'), error = node('p', '', 'agent-error');
  status.setAttribute('role', 'status'); error.setAttribute('role', 'alert');
  const refresh = node('button', 'Refresh progress'); refresh.type = 'button';
  const review = node('a', 'Open translations to review'); review.hidden = true;
  const stop = node('button', 'Stop job'); stop.type = 'button'; stop.hidden = !onStop;
  card.append(title, status, detail, review, refresh, stop, error);
  let timer, busy = false;
  const load = async () => {
    if (busy) return; busy = true; clearTimeout(timer); refresh.disabled = true; error.textContent = '';
    try {
      const { result } = await request('/api/actions/localization_job.status', { jobId });
      const job = result.job, count = job.progress.succeeded || 0;
      title.textContent = job.name;
      status.textContent = `${names[job.status] || job.status}${job.batch ? ` · ${count} of ${job.batch.pairs} drafts saved` : ''}`;
      detail.textContent = job.batch ? `${job.batch.remainingPairs} additional missing translations outside this batch. Existing translations are preserved. Review and publishing remain separate.` : 'Start a preview to see the languages, provider and work limit.';
      if (job.errors.length) error.textContent = job.errors.map(e => `${e.locale}: ${e.message}`).join(' ');
      review.href = `/?project=${encodeURIComponent(job.projectSlug)}#review`; review.hidden = !count;
      review.onclick = async event => { if (window.HedgelingConsole?.openProject) { event.preventDefault(); try { await window.HedgelingConsole.openProject(job.projectSlug, { manual: true }); } catch(e) { error.textContent = e.message; } } };
      stop.hidden = !onStop || !['queued', 'running'].includes(job.status);
      if (['queued', 'running'].includes(job.status)) timer = setTimeout(() => { if (card.isConnected) void load(); }, 2500);
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; refresh.disabled = false; }
  };
  refresh.addEventListener('click', load);
  stop.addEventListener('click', async () => { stop.disabled = true; try { await onStop(jobId); } catch(e) { error.textContent = e.message; } finally { stop.disabled = false; } });
  card.addEventListener('translation-job-refresh', load);
  void load(); return card;
}

export function translationJobControls({ job, request, confirmation, controllerId, onChanged }) {
  const root = node('div', '', 'translation-job-controls');
  const slot = node('div'), error = node('p', '', 'agent-error'); error.setAttribute('role', 'alert');
  const preview = async (action, input) => {
    error.textContent = '';
    const { result } = await request(`/api/actions/${action}`, input);
    const proposal = result.proposal;
    const discard = async () => { await request(`/api/agent/proposals/${proposal.id}/reject`, {}); slot.replaceChildren(); };
    slot.replaceChildren(confirmation(proposal, { edit: discard, cancel: discard,
      confirm: async () => {
        await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint });
        slot.replaceChildren(); await onChanged?.();
      } }));
    slot.querySelector('h3')?.focus();
  };
  if (job.canStart) {
    const label = node('label', 'Maximum translations in this batch ');
    const maximum = node('input'); maximum.type = 'number'; maximum.min = '1'; maximum.max = '200'; maximum.value = '100'; maximum.required = true; maximum.style.width = '5rem';
    label.append(maximum);
    const start = node('button', 'Preview translation start'); start.type = 'button';
    start.addEventListener('click', async () => { if (!maximum.reportValidity()) return; start.disabled = true;
      try { await preview('localization_job.start', { jobId: job.id, maxTranslations: Number(maximum.value) }); } catch(e) { error.textContent = e.message; }
      finally { start.disabled = false; } });
    root.append(label, start);
  }
  if (job.status !== 'draft') root.append(translationJobProgress({ jobId: job.id, request,
    onStop: job.canStop ? id => preview('localization_job.cancel', { jobId: id }) : null }));
  root.append(slot, error); return root;
}
