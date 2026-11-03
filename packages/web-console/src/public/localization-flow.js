import { workflowProgress } from './workflow-progress.js';
import { LOCALIZATION_WORKFLOWS } from './localization-workflows.js';
const node = (tag, text = '', className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };
// One component and one server-derived next step in Projects and chat.
// Polling only reads bounded counts; it never calls a model or confirms work.
export function localizationFlowCard({ projectSlug, request, confirmation, controllerId, onNavigate, onChanged }) {
  if (!document.querySelector('link[data-localization-flow]')) {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/localization-flow.css'; css.dataset.localizationFlow = ''; document.head.append(css);
  }
  const root = node('section', '', 'localization-flow-card'); root.dataset.flowProject = projectSlug;
  root.setAttribute('aria-label', 'Guided localization');
  const title = node('h4', 'Your next step'), status = node('p', 'Loading saved workflow…'), counts = node('p', '', 'agent-card-help');
  const choices = node('div', '', 'localization-flow-actions'), slot = node('div'), settings = node('details', '', 'localization-flow-settings');
  const refresh = node('button', 'Refresh next step'), error = node('p', '', 'agent-error'); error.setAttribute('role', 'alert'); refresh.type = 'button';
  root.append(node('span', 'GUIDED LOCALIZATION', 'agent-eyebrow'), title, status, counts, choices, settings, refresh, slot, error);
  const progress = workflowProgress('Current step'); root.insertBefore(progress.root, choices);
  let current, timer, busy = false, pending = false, generation = 0;
  const button = (label, action, parent = choices) => {
    const b = node('button', label); b.type = 'button'; b.onclick = async () => {
      if (busy || pending) return; b.disabled = true; error.textContent = '';
      try { await action(); } catch (e) { error.textContent = e.message; } finally { b.disabled = false; }
    }; parent.append(b); return b;
  };
  const navigate = async (section, review = false) => {
    if (review && window.HedgelingConsole?.openProject) return window.HedgelingConsole.openProject(projectSlug, { manual: true });
    await onNavigate?.({ section, step: current?.next.id, jobId: current?.job?.id, projectSlug });
  };
  const preview = async (action, input) => {
    busy = true; generation++;
    try {
      const { result } = await request(`/api/actions/${action}`, input), proposal = result.proposal;
      pending = true; clearTimeout(timer);
      const discard = async () => { await request(`/api/agent/proposals/${proposal.id}/reject`, {}); pending = false; slot.replaceChildren(); await load(); };
      slot.replaceChildren(confirmation(proposal, { cancel: discard, edit: discard, confirm: async () => {
        await request(`/api/agent/proposals/${proposal.id}/confirm`, { controllerId, fingerprint: proposal.fingerprint });
        slot.replaceChildren();
        try { await onChanged?.(); } finally { pending = false; await load(); }
      } }));
      slot.scrollIntoView({ block: 'nearest' });
    } finally { busy = false; }
  };
  const configure = changes => preview('localization_flow.configure', { projectSlug, revision: current.choices.revision, ...changes });
  const draftForm = () => {
    const form = node('form', '', 'localization-flow-draft');
    const nameLabel = node('label', 'Job name'), name = node('input'); name.required = true; name.maxLength = 200; name.value = `${current.projectName} translations`; nameLabel.append(name);
    const localesLabel = node('label', 'Target languages, separated by commas'), locales = node('input'); locales.required = true;
    locales.value = (current.job?.targetLocales || current.targetLocales).join(', '); localesLabel.append(locales);
    const create = node('button', 'Preview job draft'); create.type = 'submit';
    form.append(nameLabel, localesLabel, create); choices.append(form);
    form.onsubmit = async event => { event.preventDefault(); if (busy || pending) return; create.disabled = true; error.textContent = '';
      try { await preview('localization_job.create', { projectSlug, name: name.value.trim(), targetLocales: locales.value.split(',').map(v => v.trim()).filter(Boolean), workflowPreset: current.choices.workflowPreset }); }
      catch (e) { error.textContent = e.message; } finally { create.disabled = false; }
    };
  };
  function render(flow) {
    current = flow; const { next, context, job, canManage } = flow;
    progress.root.hidden = true;
    if (next.id === 'context_running') progress.update({ state: 'running', title: 'Generating context suggestions', completed: flow.contextRun.completedStrings, total: flow.contextRun.strings, unit: 'suggestions saved' });
    if (next.id === 'translating') progress.update({ state: 'running', title: 'Translation coverage', completed: job.coverage.saved, total: job.coverage.total, unit: 'translations saved' });
    if (next.id === 'quality_running') progress.update({ state: 'running', title: 'AI quality check', completed: flow.quality.checked, total: flow.quality.total, unit: 'translations checked' });
    root.dataset.flowStep = next.id; title.textContent = next.title; status.textContent = next.description;
    counts.textContent = `${context.totalStrings} source strings · ${context.currentContext ?? 'Unknown'} with current accepted context${flow.choices.contextChoice === 'skip' ? ' · Enrichment skipped' : ''}${flow.choices.workflowPreset ? ` · ${LOCALIZATION_WORKFLOWS[flow.choices.workflowPreset].label}` : ''}`;
    if (job) counts.textContent += ` · ${job.coverage.userApproved} approved after AI assessment · ${job.coverage.humanReviewed} human reviewed`;
    choices.replaceChildren(); settings.replaceChildren(node('summary', 'Saved workflow choices')); settings.hidden = !canManage;
    if (canManage) {
      const contextLabel = node('label', 'Context'), contextSelect = node('select');
      contextSelect.append(new Option('Choose…', ''), new Option('Enrich missing context', 'enrich'), new Option('Continue with existing context', 'skip')); contextSelect.value = flow.choices.contextChoice || ''; contextLabel.append(contextSelect);
      const workflowLabel = node('label', 'Workflow'), workflowSelect = node('select'); workflowSelect.append(new Option('Choose…', ''));
      for (const [id, value] of Object.entries(LOCALIZATION_WORKFLOWS)) workflowSelect.append(new Option(value.label, id)); workflowSelect.value = flow.choices.workflowPreset || ''; workflowLabel.append(workflowSelect);
      settings.append(contextLabel, workflowLabel);
      button('Preview saved choices', () => {
        const changes = {};
        if (contextSelect.value) changes.contextChoice = contextSelect.value;
        if (workflowSelect.value) changes.workflowPreset = workflowSelect.value;
        if (!Object.keys(changes).length) throw new Error('Choose context or a workflow first.');
        return configure(changes);
      }, settings);
    }
    if (next.id === 'context_choice' && canManage) {
      button('Enrich missing context (recommended)', () => configure({ contextChoice: 'enrich' }));
      button('Continue with existing context', () => configure({ contextChoice: 'skip' }));
      choices.append(node('p', 'Enrichment adds meaning and usage guidance. It uses your organization’s AI key; the next preview shows the request budget. Skipping is faster and starts no paid work.', 'agent-card-help'));
    } else if (next.id === 'workflow_choice' && canManage) {
      for (const [id, preset] of Object.entries(LOCALIZATION_WORKFLOWS)) {
        const option = node('div', '', 'localization-flow-option'); button(preset.label, () => configure({ workflowPreset: id }), option);
        option.append(node('p', preset.description, 'agent-card-help')); choices.append(option);
      }
    } else if (next.id === 'context_enrich' && canManage) {
      button('Preview context enrichment', () => preview('context.enrich', { projectSlug, allMissing: true }));
      button('Continue with existing context', () => configure({ contextChoice: 'skip' }));
    } else if (['create_job', 'translation_attention'].includes(next.id) && canManage) {
      draftForm(); if (job) button('Inspect current job', () => navigate('05'));
    } else if (next.id === 'translate') button('Preview translation start', () => preview('localization_job.start', { jobId: job.id }));
    else if (next.id === 'quality_check' && job.coverage.total <= 1000) button('Preview AI quality check', () => preview('localization_job.review', { jobId: job.id, selection: 'all' }));
    else if (next.id === 'quality_approve') {
      button('Inspect AI findings', () => navigate('05'));
      button('Preview approval of passing results', () => preview('localization_job.verify', { jobId: job.id, runId: flow.quality.id }));
    } else button(next.id === 'human_review' || next.id === 'review_findings' ? 'Open translation review' : next.id === 'context_accept' ? 'Review context suggestions' : next.id === 'deliver' ? 'Open PR delivery' : 'Open this step', () => navigate(next.section, ['human_review', 'review_findings'].includes(next.id)));
    if (next.id === 'quality_check' && job.coverage.total > 1000) choices.append(node('p', 'Quality checks support up to 1,000 translations per request. Choose a smaller language selection in the job’s quality controls.'));
    if (flow.lastPullRequest?.url) {
      const a = node('a', `Last delivery: PR #${flow.lastPullRequest.number}`); a.href = flow.lastPullRequest.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; choices.append(a);
    }
  }
  async function load() {
    if (pending) return;
    const attempt = ++generation;
    clearTimeout(timer); refresh.disabled = true;
    try {
      const { result } = await request('/api/actions/localization_flow.get', { projectSlug }); if (attempt !== generation || pending) return; render(result.flow); error.textContent = '';
      // The component stops polling on removal, hidden tabs, or a pending preview.
      if (['context_running', 'translating', 'quality_running'].includes(current.next.id)) timer = setTimeout(() => {
        if (root.isConnected && !document.hidden) void load();
      }, 4000);
    } catch (e) { status.textContent = 'Next step unavailable'; error.textContent = e.message; }
    finally { refresh.disabled = false; }
  }
  refresh.onclick = load; root.addEventListener('localization-flow-refresh', load); void load(); return root;
}
