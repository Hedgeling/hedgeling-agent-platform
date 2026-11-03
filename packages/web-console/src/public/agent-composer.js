// Shared by the real conversation and the read-only card playground.
export function bindComposer(form) {
  const input = form.querySelector('textarea');
  const send = form.querySelector('button[type="submit"]');
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl+Enter';
  form.querySelector('.agent-input-help').textContent = `Enter for a new line · ${shortcut} to send`;
  send.title = `Send message (${shortcut})`;
  send.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
  function resize() {
    if (!input.getClientRects().length) return;
    const scrollTop = input.scrollTop;
    const line = parseFloat(getComputedStyle(input).lineHeight);
    const minimum = line * 3;
    const maximum = Math.max(minimum, Math.min(line * 8, (window.visualViewport?.height || innerHeight) * .25));
    input.style.maxHeight = `${maximum}px`;
    input.style.height = 'auto';
    input.style.height = `${Math.max(minimum, Math.min(input.scrollHeight, maximum))}px`;
    input.style.overflowY = input.scrollHeight > input.clientHeight + 1 ? 'auto' : 'hidden';
    input.scrollTop = scrollTop;
  }
  input.addEventListener('input', resize);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!input.disabled && !send.disabled) form.requestSubmit(send);
    }
  });
  let previousWidth = 0;
  const observer = new ResizeObserver(() => {
    const width = input.getBoundingClientRect().width;
    if (width !== previousWidth) { previousWidth = width; resize(); }
  });
  observer.observe(input);
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  document.fonts.ready.then(resize);
  resize();
  return { resize, setValue(value) { input.value = value; input.scrollTop = 0; resize(); } };
}
