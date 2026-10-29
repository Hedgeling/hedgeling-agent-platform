// SPDX-License-Identifier: Apache-2.0
const node = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const button = text => { const n = node('button', text); n.type = 'button'; return n; };
const field = (label, control) => { const n = node('label', label); control.setAttribute('aria-label', label); n.append(control); return n; };
export function fileCard(file) {
  const card = node('article', '', 'document-file-card');
  card.append(node('strong', file.filename), node('p', `${file.label || 'File'} · ${Math.ceil(file.bytes / 1024)} KiB`));
  const download = button('Download'), error = node('p', '', 'agent-error'); error.setAttribute('role', 'alert');
  download.onclick = async () => {
    download.disabled = true; error.textContent = '';
    try {
      const href = new URL(file.href, location.origin);
      if (href.origin !== location.origin || !href.pathname.startsWith('/api/documents/jobs/')) throw new Error('Invalid download link.');
      const response = await fetch(href, { credentials: 'same-origin' });
      if (!response.ok) throw new Error((await response.json()).error || 'Download unavailable.');
      const url = URL.createObjectURL(await response.blob()), link = node('a'); link.href = url; link.download = file.filename;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch(e) { error.textContent = e.message; } finally { download.disabled = false; }
  };
  card.append(download, error); return card;
}

export function documentExports({ job, request }) {
  const root = node('details', '', 'document-export'); root.append(node('summary', 'Download document translations'));
  const locale = node('select'); for (const l of job.targetLocales) locale.append(new Option(l, l));
  const format = node('select'); format.append(new Option('Plain text (.txt)', 'txt'), new Option('Bilingual review (.csv)', 'csv'));
  const status = node('select'); status.append(new Option('Approved translations only', 'approved'), new Option('Include drafts for review', 'drafts'));
  const go = button('Prepare download'), output = node('div'), error = node('p', '', 'agent-error'); error.setAttribute('role', 'alert');
  root.append(field('Language', locale), field('Format', format), field('Translation status', status), go, output, error);
  go.onclick = async () => { go.disabled = true; error.textContent = ''; output.replaceChildren();
    try { const { result } = await request('/api/actions/documents.export', { jobId: job.id, locale: locale.value, format: format.value, status: status.value }); output.replaceChildren(...result.files.map(fileCard)); }
    catch(e) { error.textContent = e.message; } finally { go.disabled = false; }
  };
  return root;
}

export function documentPanel({ project, request, confirmation, controllerId, onChanged, onChoose }) {
  const root = node('details', '', 'document-panel'); root.append(node('summary', 'Documents · upload and translate'));
  root.dataset.projectSlug = project.slug;
  root.addEventListener('input', event => { if (event.target.closest('form')) root.dataset.documentDirty = 'true'; });
  const form = node('form'), input = node('input'); input.type = 'file'; input.accept = '.md,.markdown,.txt,.docx,.pdf'; input.required = true;
  const submit = node('button', 'Upload and inspect'); submit.type = 'submit';
  const status = node('p'); status.setAttribute('role', 'status');
  const error = node('p', '', 'agent-error'); error.setAttribute('role', 'alert');
  const inspect = node('div'), history = node('div'), refresh = button('Browse uploaded documents'), more = button('More documents'); more.hidden = true;
  const policy = node('p', `Source language: ${project.sourceLocale || 'project language'}. Maximum 5 MiB, 200 text sections, or 30 PDF pages. Text translation only; no OCR or preserved Word/PDF layout. Uploading stores a preview; translation needs your confirmation.`);
  form.append(field('Document', input), submit); root.append(policy, form, status, error, inspect, refresh, history, more);
  let cursor = null;
  async function select(documentId) {
    inspect.replaceChildren(); error.textContent = '';
    const { result } = await request('/api/actions/documents.get', { documentId });
    const d = result.document;
    const preview = node('section', '', 'document-preview'); preview.append(node('h4', d.filename), node('p', `${d.sections} text sections · source ${d.sourceLocale}`));
    for (const warning of d.warnings) preview.append(node('p', warning));
    const sections = node('div', '', 'document-sections');
    const append = rows => { for (const s of rows) { const detail = node('details'); detail.append(node('summary', s.location), node('pre', s.text)); sections.append(detail); } };
    append(result.sections); let offset = result.page.nextOffset;
    const next = button('Show more sections'); next.hidden = offset === null;
    next.onclick = async () => { next.disabled = true; try { const r = (await request('/api/actions/documents.get', { documentId, offset })).result; append(r.sections); offset = r.page.nextOffset; next.hidden = offset === null; } catch(e) { error.textContent = e.message; } finally { next.disabled = false; } };
    preview.append(sections, next); inspect.append(preview);
    if (onChoose) { const choose = button('Discuss this document in chat'); choose.onclick = () => onChoose({ document: d, projectSlug: project.slug }); preview.append(node('p', 'Hedgeling can read these sections using the chat provider when you send your message.'), choose); return; }
    const jobForm = node('form'), name = node('input'); name.value = d.filename.replace(/\.[^.]+$/, '') + ' translation'; name.required = true; name.maxLength = 200;
    const languages = (await request('/api/actions/project.locales.get', { projectSlug: project.slug })).result;
    const options = node('fieldset'); options.append(node('legend', 'Target languages'));
    for (const l of languages.targetLocales) { const check = node('input'); check.type = 'checkbox'; check.value = l; options.append(field(l, check)); }
    if (!languages.targetLocales.length) options.append(node('p', 'Add target languages to this project first.'));
    const create = node('button', 'Review document job'); create.type = 'submit'; const slot = node('div');
    jobForm.append(field('Job name', name), options, create); preview.append(jobForm, slot);
    jobForm.onsubmit = async event => {
      event.preventDefault(); create.disabled = true; error.textContent = '';
      try {
        const targetLocales = [...options.querySelectorAll('input:checked')].map(n => n.value);
        if (!targetLocales.length) throw new Error('Choose at least one target language.');
        const { result } = await request('/api/actions/documents.job', { documentId, name: name.value, targetLocales });
        const p = result.proposal;
        const discard = async () => { await request(`/api/agent/proposals/${p.id}/reject`, {}); slot.replaceChildren(); jobForm.hidden = false; root.dataset.documentDirty = 'false'; };
        slot.replaceChildren(confirmation(p, { edit: discard, cancel: discard, confirm: async () => {
          const saved = await request(`/api/agent/proposals/${p.id}/confirm`, { controllerId, fingerprint: p.fingerprint });
          root.dataset.documentDirty = 'false';
          slot.replaceChildren(node('p', 'Document imported and job draft created. Review translation start in the job below.')); jobForm.hidden = true;
          await onChanged?.(saved.result.job.id);
        } })); jobForm.hidden = true;
      } catch(e) { error.textContent = e.message; } finally { create.disabled = false; }
    };
  }
  form.onsubmit = async event => {
    event.preventDefault(); submit.disabled = true; error.textContent = ''; status.textContent = 'Reading document…';
    try {
      const file = input.files[0]; if (!file || file.size > 5 * 1024 * 1024) throw new Error('Choose a document no larger than 5 MiB.');
      const response = await fetch(`/api/documents/upload?project=${encodeURIComponent(project.slug)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': encodeURIComponent(file.name) }, body: file });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Upload failed.');
      status.textContent = 'Upload ready to inspect. Nothing has been imported or translated.'; input.value = ''; root.dataset.documentDirty = 'false'; await select(result.document.id);
    } catch(e) { status.textContent = ''; error.textContent = e.message; } finally { submit.disabled = false; }
  };
  const list = async reset => {
    refresh.disabled = more.disabled = true; error.textContent = '';
    try {
      if (reset) { cursor = null; history.replaceChildren(); }
      const { result } = await request('/api/actions/documents.list', { projectSlug: project.slug, ...(cursor ? { cursor } : {}) });
      for (const d of result.documents) { const choose = button(`${d.filename} · ${d.sections} sections`); choose.onclick = () => select(d.id).catch(e => { error.textContent = e.message; }); history.append(choose); }
      if (reset && !result.documents.length) history.append(node('p', 'No uploaded documents yet.'));
      cursor = result.page.nextCursor; more.hidden = !cursor;
    } catch(e) { error.textContent = e.message; } finally { refresh.disabled = more.disabled = false; }
  };
  refresh.onclick = () => list(true); more.onclick = () => list(false);
  return root;
}

export async function openDocumentUpload({ root, organizationId, request, onChoose }) {
  const dialog = node('dialog', '', 'document-dialog'), close = button('Close'), content = node('div'), error = node('p', '', 'agent-error');
  close.onclick = () => dialog.close(); dialog.addEventListener('close', () => dialog.remove());
  const search = node('input'); search.type = 'search'; search.placeholder = 'Find a project';
  const choose = node('select'); choose.setAttribute('aria-label', 'Project for this document');
  const find = button('Find projects'), more = button('More projects'); more.hidden = true;
  dialog.append(node('h2', 'Upload a document'), close, field('Project search', search), find, choose, more, error, content); root.append(dialog); dialog.showModal();
  let cursor = null, projects = [], query = '';
  const show = () => { const p = projects.find(p => p.slug === choose.value); content.replaceChildren(); if (p) { const panel = documentPanel({ project: p, request, onChoose: value => { onChoose(value); dialog.close(); } }); panel.open = true; content.append(panel); } };
  const load = async reset => {
    error.textContent = ''; find.disabled = more.disabled = true;
    try {
      if (reset) { cursor = null; projects = []; choose.replaceChildren(); query = search.value.trim(); }
      const result = (await request('/api/actions/projects.list', { organizationId, limit: 100, ...(query ? { search: query } : {}), ...(cursor ? { cursor } : {}) })).result;
      for (const p of result.projects) { projects.push(p); choose.append(new Option(p.name, p.slug)); }
      cursor = result.page.nextCursor; more.hidden = !cursor;
      if (reset) show(); if (!projects.length) error.textContent = 'No accessible projects found.';
    } catch(e) { error.textContent = e.message; } finally { find.disabled = more.disabled = false; }
  };
  choose.onchange = show; find.onclick = () => load(true); more.onclick = () => load(false); await load(true);
}
