export function activityGroup(container) {
  let group, summary, list, count = 0, failed = false;
  const pending = new Map();
  const node = (tag, text = '') => { const el = document.createElement(tag); el.textContent = text; return el; };
  return {
    reset() { group = summary = list = null; pending.clear(); count = 0; failed = false; },
    finish(state) {
      if (!group) return;
      const interrupted = pending.size && ['paused', 'cancelled'].includes(state);
      group.dataset.status = failed ? 'failed' : interrupted ? 'paused' : 'complete';
      summary.textContent = `${failed ? 'Attention needed' : interrupted ? 'Activity stopped' : 'Activity complete'} · ${count} ${count === 1 ? 'step' : 'steps'}`;
    },
    add(data) {
      if (!group) {
        group = node('details'); group.className = 'agent-activity-group';
        summary = node('summary'); list = node('ol'); group.append(summary, list); container.append(group);
      }
      group.dataset.status = data.status;
      const key = data.tool || '';
      const queue = pending.get(key) || [];
      let line = queue[0];
      if (data.status === 'working' || !line) {
        line = node('li', data.label); line.className = 'agent-activity'; list.append(line); count++;
        if (data.status === 'working') { queue.push(line); pending.set(key, queue); }
      }
      line.dataset.status = data.status;
      if (data.status === 'failed') { failed = true; if (line.textContent !== data.label) line.append(node('p', data.label)); }
      else if (data.status === 'complete') line.setAttribute('aria-label', `${line.textContent} · Complete`);
      summary.textContent = data.status === 'working' ? `${data.label} · ${count} ${count === 1 ? 'step' : 'steps'}`
        : `${failed ? 'Attention needed' : 'Activity'} · ${count} ${count === 1 ? 'step' : 'steps'}`;
      if (data.status !== 'working') { queue.shift(); if (!queue.length) pending.delete(key); }
    },
  };
}
