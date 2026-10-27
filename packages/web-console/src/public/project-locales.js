// SPDX-License-Identifier: Apache-2.0
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
const common = ['ar', 'de', 'en-GB', 'es', 'es-ES', 'es-MX', 'fr', 'fr-CA', 'hi', 'it', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'pt-PT', 'sv', 'uk', 'zh-Hans', 'zh-Hant'];
const names = new Intl.DisplayNames(['en'], { type: 'language' });
function label(locale) { try { return `${names.of(locale.replaceAll('_', '-'))} · ${locale}`; } catch { return locale; } }
export function projectLanguages({ project, request, confirmation, controllerId, onSaved = async () => {} }) {
  if (!document.querySelector('link[data-project-languages]')) {
    const style = node('link'); style.rel = 'stylesheet'; style.href = '/project-locales.css'; style.dataset.projectLanguages = ''; document.head.append(style);
  }
  const section = node('section', null, 'project-languages'); section.dataset.projectId = project.id; section.dataset.projectSlug = project.slug;
  section.setAttribute('aria-label', `Languages for ${project.name}`);
  const heading = node('h3', 'Languages');
  const source = node('p', project.sourceLocale ? `Source: ${label(project.sourceLocale)}` : 'Source language is not configured.', 'project-language-source');
  const targets = node('div', null, 'project-language-targets'); targets.setAttribute('aria-label', 'Enabled target languages');
  const drawTargets = values => { targets.replaceChildren(); for (const locale of values) targets.append(node('span', label(locale), 'project-language-tag')); if (!values.length) targets.append(node('p', 'No target languages yet.')); };
  drawTargets(project.targetLocales || []); section.append(heading, source, targets);
  if (!project.canManageLocales) return section;
  const details = node('details'); details.dataset.workspaceAction = 'project.locales.add';
  details.append(node('summary', 'Add target languages'));
  const form = node('form'); const fields = node('fieldset', null, 'workspace-form-fields');
  const field = node('label', 'Languages to add'); const input = node('input'); input.name = 'targetLocales'; input.required = true; input.maxLength = 3000;
  input.placeholder = 'For example: fr-CA, de, ja'; input.autocomplete = 'off';
  const list = node('datalist'); list.id = `language-options-${project.id}`;
  for (const locale of common.filter(l => l !== project.sourceLocale && !project.targetLocales?.includes(l))) { const option = node('option'); option.value = locale; option.label = label(locale); list.append(option); }
  input.setAttribute('list', list.id);
  const help = node('p', 'Choose a suggestion or enter language codes separated by commas. For example, fr-CA is French (Canada).', 'project-language-note'); help.id = `language-help-${project.id}`; input.setAttribute('aria-describedby', help.id);
  field.append(input); fields.append(field, list, help);
  const submit = node('button', 'Review languages', 'primary'); submit.type = 'submit';
  const error = node('p', null, 'agent-error'); error.setAttribute('role', 'alert');
  const review = node('div'); const status = node('p', null, 'project-language-status'); status.setAttribute('role', 'status');
  form.append(fields, submit, error); details.append(form, review, status); section.append(details);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled) return;
    fields.disabled = submit.disabled = true; error.textContent = ''; status.textContent = '';
    try {
      const result = (await request('/api/actions/project.locales.add', { projectSlug: project.slug, targetLocales: [...new Set(input.value.split(',').map(v => v.trim()).filter(Boolean))] })).result;
      const proposal = result.proposal;
      const back = async cancel => {
        await request(`/api/agent/proposals/${proposal.id}/reject`, {});
        review.replaceChildren(); form.hidden = false;
        if (cancel) { form.reset(); details.open = false; details.querySelector('summary').focus(); } else input.focus();
      };
      review.replaceChildren(confirmation(proposal, {
        edit: () => back(false), cancel: () => back(true),
        confirm: async () => {
          const saved = await request(`/api/agent/proposals/${proposal.id}/confirm`, { fingerprint: proposal.fingerprint, controllerId });
          project.targetLocales = saved.result.project.targetLocales;
          drawTargets(project.targetLocales); review.replaceChildren(); form.hidden = false; form.reset();
          status.textContent = `Added ${saved.result.addedLocales.join(', ')}. These languages are ready for translation. Existing jobs keep their current selection.`;
          // A refresh failure must not turn a confirmed save into a retryable write.
          try { await onSaved(); } catch { status.textContent += ' Refresh the page to update the translation selector.'; }
          details.querySelector('summary').focus();
        },
      }));
      form.hidden = true; review.querySelector('h3')?.focus();
    } catch (e) { error.textContent = e.message; }
    finally { fields.disabled = submit.disabled = false; }
  });
  return section;
}
