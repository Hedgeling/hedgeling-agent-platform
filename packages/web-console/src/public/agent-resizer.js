export function panelResizer(handle) {
  let width = 480, dragging = false;
  try { width = Number(localStorage.getItem('hedgeling.agent.panelWidth')) || width; } catch { /* Use default. */ }
  const bounds = () => ({ min: 360, max: Math.max(360, Math.min(900, window.innerWidth - 360)) });
  function set(value, persist = false) {
    const { min, max } = bounds(); width = Math.max(min, Math.min(max, Number.isFinite(value) ? value : 480));
    document.documentElement.style.setProperty('--agent-panel-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(width)); handle.setAttribute('aria-valuetext', `${Math.round(width)} pixels wide`);
    if (persist) try { localStorage.setItem('hedgeling.agent.panelWidth', String(width)); } catch { /* Resizing still works. */ }
  }
  function stop() { if (!dragging) return; dragging = false; document.body.classList.remove('agent-resizing'); set(width, true); }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return; event.preventDefault(); dragging = true;
    handle.setPointerCapture(event.pointerId); handle.focus(); document.body.classList.add('agent-resizing');
  });
  handle.addEventListener('pointermove', event => { if (dragging) set(window.innerWidth - event.clientX + 12); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, stop);
  window.addEventListener('blur', stop);
  handle.addEventListener('keydown', event => {
    const { min, max } = bounds(), step = event.shiftKey ? 64 : 24;
    const value = { ArrowLeft: width + step, ArrowRight: width - step, Home: min, End: max }[event.key];
    if (value !== undefined) { event.preventDefault(); set(value, true); }
  });
  handle.addEventListener('dblclick', () => set(480, true));
  window.addEventListener('resize', () => set(width)); set(width);
}
