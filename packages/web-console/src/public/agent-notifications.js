// Announce useful turn boundaries, never every tool call or replayed message.
export function agentNotifications({ launcher, soundButton, open, isReading }) {
  const region = document.createElement('aside'); region.className = 'agent-notifications';
  region.setAttribute('aria-label', 'Agent notifications'); region.hidden = true;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const view = document.createElement('button'); view.type = 'button'; view.textContent = 'View conversation';
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
  region.append(status, view, dismiss); document.body.append(region);
  const badge = document.createElement('span'); badge.className = 'agent-unread'; badge.hidden = true; launcher.append(badge);
  let sound = false, audio, unread = 0, lastChime = 0;
  try { sound = localStorage.getItem('hedgeling.agent.sound') === 'true'; } catch { /* Session preference still works. */ }
  function soundLabel() {
    const label = sound ? 'Sound on' : 'Sound off';
    soundButton.querySelector('.agent-tool-label').textContent = label;
    soundButton.setAttribute('aria-label', label);
    soundButton.setAttribute('aria-pressed', String(sound));
  }
  async function unlockAudio() {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio) { audio ||= new Audio(); if (audio.state === 'suspended') await audio.resume(); }
    } catch { /* A visual notification always remains available. */ }
  }
  async function chime() {
    if (!sound || !audio || audio.state !== 'running' || Date.now() - lastChime < 1500) return;
    lastChime = Date.now();
    const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, now); oscillator.frequency.setValueAtTime(880, now + .1);
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(.07, now + .015); gain.gain.exponentialRampToValueAtTime(.001, now + .3);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(now); oscillator.stop(now + .32);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
  soundButton.addEventListener('click', async () => {
    sound = !sound; try { localStorage.setItem('hedgeling.agent.sound', String(sound)); } catch { /* Use session preference. */ }
    soundLabel(); if (sound) { await unlockAudio(); await chime(); }
  });
  // Browsers require a user gesture to unlock audio after a reload.
  document.addEventListener('pointerdown', () => { if (sound) void unlockAudio(); });
  document.addEventListener('keydown', () => { if (sound) void unlockAudio(); });
  function clear() { unread = 0; badge.hidden = true; region.hidden = true; launcher.removeAttribute('data-unread'); }
  view.onclick = () => { open(); clear(); }; dismiss.onclick = () => { region.hidden = true; };
  soundLabel();
  return {
    region,
    clear,
    read() { if (isReading()) clear(); },
    show(label) {
      void chime();
      if (isReading()) return;
      unread++; badge.textContent = String(unread); badge.hidden = false;
      badge.setAttribute('aria-label', `${unread} unread updates`); launcher.dataset.unread = String(unread);
      status.textContent = label; region.hidden = false;
    },
  };
}
