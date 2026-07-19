import { getSettings, normalizeDomain, saveSettings } from '../shared/common.js';

const el = (id) => document.getElementById(id);
const savedLine = el('saved');
const siteList = el('site-list');
const addForm = el('add-site-form');
const addInput = el('add-site');
const addError = el('add-error');

let settings = await getSettings();

// Another context (the popup's master toggle, a second options tab) may
// write settings while this page holds its editable snapshot. Two guards:
// persist() re-reads `enabled` (owned by the popup) before each write, and
// onChanged re-syncs the whole page when a foreign write lands.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !changes.settings) return;
  const fresh = await getSettings();
  if (JSON.stringify(fresh) === JSON.stringify(settings)) return; // our own write
  settings = fresh;
  renderAll();
});

function bindSchedule(dayType) {
  const cfg = () => settings.schedule[dayType];
  el(`${dayType}-active`).addEventListener('change', (e) => {
    cfg().active = e.target.checked;
    persist();
  });
  el(`${dayType}-start`).addEventListener('change', (e) => {
    if (e.target.value) {
      cfg().start = e.target.value;
      persist();
    } else {
      e.target.value = cfg().start; // cleared input: keep showing the stored time
    }
  });
  el(`${dayType}-end`).addEventListener('change', (e) => {
    if (e.target.value) {
      cfg().end = e.target.value;
      persist();
    } else {
      e.target.value = cfg().end;
    }
  });
}

function renderSchedule(dayType) {
  const cfg = settings.schedule[dayType];
  el(`${dayType}-active`).checked = cfg.active;
  el(`${dayType}-start`).value = cfg.start;
  el(`${dayType}-end`).value = cfg.end;
}

function renderSites() {
  siteList.replaceChildren();
  const domains = Object.keys(settings.sites).sort();
  for (const domain of domains) {
    const li = document.createElement('li');
    li.classList.toggle('off', !settings.sites[domain]);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = settings.sites[domain];
    toggle.setAttribute('aria-label', `Pause ${domain}`);
    toggle.addEventListener('change', () => {
      settings.sites[domain] = toggle.checked;
      li.classList.toggle('off', !toggle.checked);
      persist();
    });

    const label = document.createElement('span');
    label.className = 'domain';
    label.textContent = domain;

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = 'remove';
    remove.setAttribute('aria-label', `Remove ${domain}`);
    remove.addEventListener('click', () => {
      delete settings.sites[domain];
      renderSites();
      addInput.focus(); // rebuilding the list would drop keyboard focus to <body>
      persist();
    });

    li.append(toggle, label, remove);
    siteList.append(li);
  }
}

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const domain = normalizeDomain(addInput.value);
  if (!domain) {
    addError.hidden = false;
    return;
  }
  addError.hidden = true;
  settings.sites[domain] = true;
  addInput.value = '';
  renderSites();
  persist();
});

addInput.addEventListener('input', () => {
  addError.hidden = true;
});

el('pause-seconds').addEventListener('change', (e) => {
  const value = Number(e.target.value);
  if (e.target.value !== '' && Number.isFinite(value) && value >= 0 && value <= 300) {
    settings.pauseSeconds = Math.round(value);
    persist();
  }
  e.target.value = settings.pauseSeconds; // an empty/invalid field must not save 0
});

el('require-intent').addEventListener('change', (e) => {
  settings.requireIntent = e.target.checked;
  persist();
});

let savedTimer;
async function persist() {
  const fresh = await getSettings();
  settings.enabled = fresh.enabled; // the popup owns the master toggle
  await saveSettings(settings);
  savedLine.textContent = 'Saved.';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedLine.textContent = '';
  }, 1500);
}

function renderAll() {
  renderSchedule('weekday');
  renderSchedule('weekend');
  el('pause-seconds').value = settings.pauseSeconds;
  el('require-intent').checked = settings.requireIntent;
  renderSites();
}

bindSchedule('weekday');
bindSchedule('weekend');
renderAll();
