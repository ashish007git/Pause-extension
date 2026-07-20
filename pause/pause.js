import { DEFAULT_SETTINGS, getSettings } from '../shared/common.js';

const params = new URLSearchParams(location.search);
const target = params.get('target');
const domain = params.get('domain');
const mult = Math.max(1, Number(params.get('mult')) || 1);

const intentField = document.getElementById('intent');
const continueButton = document.getElementById('continue');
const backButton = document.getElementById('back');
const note = document.getElementById('note');
const actions = document.getElementById('actions');
const bypassSection = document.getElementById('bypass');
const bypassArena = document.getElementById('bypass-arena');
const bypassButton = document.getElementById('bypass-btn');
const bypassCount = document.getElementById('bypass-count');

if (domain) document.getElementById('site').textContent = domain;

const usable = Boolean(target && domain);
if (!usable) continueButton.hidden = true;

backButton.addEventListener('click', () => {
  backButton.disabled = true; // double-click would step back twice
  chrome.runtime.sendMessage({ type: 'back' });
});

async function attemptContinue() {
  continueButton.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'continue', domain, target });
  if (!response?.ok) {
    // E.g. the site was removed from the blocklist while this page sat open.
    continueButton.disabled = false;
    note.textContent = 'That didn’t work — the link may no longer be paused. Try it from the address bar.';
  }
}

continueButton.addEventListener('click', attemptContinue);

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

const baseSeconds = Number.isFinite(settings.pauseSeconds)
  ? Math.min(Math.max(settings.pauseSeconds, 0), 300)
  : DEFAULT_SETTINGS.pauseSeconds;
const seconds = Math.min(Math.max(baseSeconds * mult, 0), 600);

// No countdown on display — the actions simply fade in when the pause
// has run its course. `hidden` until then keeps them out of the tab
// order and the accessibility tree, not just invisible.
let countdownTimer = null;

function startCountdown() {
  clearTimeout(countdownTimer);
  countdownTimer = setTimeout(() => {
    if (requireIntent) intentField.hidden = false;
    actions.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.add('revealed');
        (requireIntent ? intentField : backButton).focus();
      });
    });
  }, seconds * 1000);
}

// Over budget: a deliberate, skill-based way to skip the wait. A button that
// jumps to a new spot on every click opens after bypassOpenSeconds; catching
// it bypassClicks times auto-fires Continue. Hard enough to rule out an
// accidental unlock, learnable enough that it stops being a wall.
const overBudget = usable && mult > 1;
bypassSection.hidden = !overBudget;

const bypassOpenSeconds = Number.isFinite(settings.bypassOpenSeconds)
  ? settings.bypassOpenSeconds
  : DEFAULT_SETTINGS.bypassOpenSeconds;
const bypassClicks = Number.isFinite(settings.bypassClicks)
  ? Math.max(1, settings.bypassClicks)
  : DEFAULT_SETTINGS.bypassClicks;

let bypassOpenTimer = null;
let clicksRemaining = bypassClicks;

function repositionBypassButton() {
  const arena = bypassArena.getBoundingClientRect();
  const maxX = Math.max(0, arena.width - bypassButton.offsetWidth);
  const maxY = Math.max(0, arena.height - bypassButton.offsetHeight);
  bypassButton.style.left = `${Math.random() * maxX}px`;
  bypassButton.style.top = `${Math.random() * maxY}px`;
}

function resetBypass() {
  clearTimeout(bypassOpenTimer);
  bypassButton.hidden = true;
  clicksRemaining = bypassClicks;
  bypassCount.textContent = clicksRemaining;
}

function startBypass() {
  if (!overBudget) return;
  resetBypass();
  bypassOpenTimer = setTimeout(() => {
    repositionBypassButton();
    bypassButton.hidden = false;
  }, bypassOpenSeconds * 1000);
}

bypassButton.addEventListener('click', () => {
  clicksRemaining -= 1;
  bypassCount.textContent = Math.max(0, clicksRemaining);
  if (clicksRemaining <= 0) {
    bypassButton.hidden = true;
    attemptContinue();
  } else {
    repositionBypassButton();
  }
});

// Chrome throttles setTimeout in background tabs, so leaving mid-countdown
// and coming back would otherwise find it done "for free". Restarting from
// full on every hide keeps the pause (and the bypass) honest.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(countdownTimer);
    actions.hidden = true;
    if (requireIntent) intentField.hidden = true;
    document.body.classList.remove('revealed');
    resetBypass();
  } else {
    startCountdown();
    startBypass();
  }
});

startCountdown();
startBypass();
