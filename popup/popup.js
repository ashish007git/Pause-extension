import { formatRemaining, getSettings, saveSettings } from '../shared/common.js';

const enabledToggle = document.getElementById('enabled');
const statusLine = document.getElementById('status');
const focusIdle = document.getElementById('focus-idle');
const focusActive = document.getElementById('focus-active');
const focusRemaining = document.getElementById('focus-remaining');
const customHours = document.getElementById('custom-hours');

async function refresh() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: 'getStatus' });
  } catch {
    status = null;
  }
  if (typeof status?.enabled !== 'boolean') {
    statusLine.textContent = 'Couldn’t reach the extension — try reopening this popup.';
    focusIdle.hidden = true;
    focusActive.hidden = true;
    return;
  }

  enabledToggle.checked = status.enabled;

  const boosted = status.focusUntil !== null && status.focusUntil > Date.now();
  focusIdle.hidden = boosted;
  focusActive.hidden = !boosted;

  if (boosted) {
    focusRemaining.textContent = formatRemaining(status.focusUntil);
    statusLine.textContent = 'Focus boost on — paused sites are armed.';
  } else if (!status.enabled) {
    statusLine.textContent = 'Off — distracting sites open freely.';
  } else if (status.inSchedule) {
    statusLine.textContent = 'Armed — inside your scheduled hours.';
  } else {
    statusLine.textContent = 'Idle — outside your scheduled hours.';
  }
}

enabledToggle.addEventListener('change', async () => {
  const settings = await getSettings();
  settings.enabled = enabledToggle.checked;
  await saveSettings(settings);
  await refresh();
});

async function startBoost(hours) {
  const result = await chrome.runtime.sendMessage({ type: 'focus', hours });
  if (result?.ok) await refresh();
  else statusLine.textContent = 'Couldn’t start the boost — pick 1 to 24 whole hours.';
}

for (const button of document.querySelectorAll('.boost')) {
  button.addEventListener('click', () => startBoost(Number(button.dataset.hours)));
}

document.getElementById('custom-start').addEventListener('click', () => {
  const hours = Number(customHours.value);
  if (customHours.value !== '' && hours >= 1 && hours <= 24) {
    startBoost(hours);
  } else {
    statusLine.textContent = 'Pick 1 to 24 hours.';
    customHours.focus();
  }
});

customHours.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('custom-start').click();
});

document.getElementById('cancel-focus').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'cancelFocus' });
  await refresh();
});

document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

await refresh();
// Keep the remaining-time line honest while the popup stays open.
setInterval(refresh, 30_000);
