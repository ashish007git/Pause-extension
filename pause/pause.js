import { DEFAULT_SETTINGS, getSettings } from '../shared/common.js';

const params = new URLSearchParams(location.search);
const target = params.get('target');
const domain = params.get('domain');

const intentField = document.getElementById('intent');
const continueButton = document.getElementById('continue');
const backButton = document.getElementById('back');
const note = document.getElementById('note');

if (domain) document.getElementById('site').textContent = domain;

const usable = Boolean(target && domain);
if (!usable) continueButton.hidden = true;

backButton.addEventListener('click', () => {
  backButton.disabled = true; // double-click would step back twice
  chrome.runtime.sendMessage({ type: 'back' });
});

continueButton.addEventListener('click', async () => {
  continueButton.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'continue', domain, target });
  if (!response?.ok) {
    // E.g. the site was removed from the blocklist while this page sat open.
    continueButton.disabled = false;
    note.textContent = 'That didn’t work — the link may no longer be paused. Try it from the address bar.';
  }
});

let settings;
try {
  settings = await getSettings();
} catch {
  settings = DEFAULT_SETTINGS; // storage hiccup: fail open, never trap the user
}

const requireIntent = settings.requireIntent && usable;
if (requireIntent) continueButton.disabled = true;
intentField.addEventListener('input', () => {
  continueButton.disabled = intentField.value.trim() === '';
});

const seconds = Number.isFinite(settings.pauseSeconds)
  ? Math.min(Math.max(settings.pauseSeconds, 0), 300)
  : DEFAULT_SETTINGS.pauseSeconds;

// No countdown on display — the actions simply fade in when the pause
// has run its course. `hidden` until then keeps them out of the tab
// order and the accessibility tree, not just invisible.
setTimeout(() => {
  if (requireIntent) intentField.hidden = false;
  document.getElementById('actions').hidden = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.add('revealed');
      (requireIntent ? intentField : backButton).focus();
    });
  });
}, seconds * 1000);
