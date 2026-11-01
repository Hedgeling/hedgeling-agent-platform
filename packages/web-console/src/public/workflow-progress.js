// SPDX-License-Identifier: Apache-2.0
// Counts come from the workflow's authenticated status response. Unknown totals
// stay indeterminate; a request budget is never presented as percent complete.
export function workflowProgress(label) {
  if (!document.querySelector('link[data-workflow-progress]')) {
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/workflow-progress.css'; style.dataset.workflowProgress = '';
    document.head.append(style);
  }
  const root = document.createElement('section'); root.className = 'workflow-progress'; root.hidden = true;
  const stage = document.createElement('p'); stage.className = 'workflow-progress-stage'; stage.setAttribute('role', 'status');
  const counts = document.createElement('p'); counts.className = 'workflow-progress-count';
  const meter = document.createElement('progress'); meter.setAttribute('aria-label', label);
  const note = document.createElement('p'); note.className = 'workflow-progress-note';
  root.append(stage, counts, meter, note);
  return { root, update({ state = 'idle', title = label, completed, total, unit = 'items', detail = '' }) {
    root.hidden = false; root.dataset.state = state;
    // Keep announcements to stage changes; counts remain available on the bar.
    if (stage.textContent !== title) stage.textContent = title;
    const measured = Number.isFinite(total) && total > 0 && Number.isFinite(completed) && completed >= 0;
    const active = ['running', 'queued'].includes(state);
    if (measured) {
      const value = Math.min(completed, total); meter.max = total; meter.value = value;
      counts.textContent = `${value.toLocaleString()} of ${total.toLocaleString()} ${unit} · ${Math.floor(value / total * 100)}%`;
      meter.setAttribute('aria-valuetext', counts.textContent);
    } else {
      meter.removeAttribute('value'); meter.removeAttribute('aria-valuetext');
      counts.textContent = active ? 'In progress' : '';
    }
    meter.hidden = !measured && !active;
    counts.hidden = !counts.textContent;
    note.textContent = detail; note.hidden = !detail;
  } };
}
