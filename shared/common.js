export const DEFAULT_SETTINGS = {
  enabled: true,
  pauseSeconds: 10,
  requireIntent: false,
  schedule: {
    weekday: { active: true, start: '09:00', end: '18:00' },
    weekend: { active: false, start: '09:00', end: '18:00' },
  },
  sites: {
    'youtube.com': true,
    'x.com': true,
    'twitter.com': true,
    'reddit.com': true,
    'instagram.com': true,
    'tiktok.com': true,
    'facebook.com': true,
  },
};

export const DEFAULT_STATE = {
  focusUntil: null,
  // One-time passes: tab id (as string) -> domain allowed in that tab.
  allowances: {},
};

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) return structuredClone(DEFAULT_SETTINGS);
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...settings,
    schedule: {
      weekday: { ...DEFAULT_SETTINGS.schedule.weekday, ...settings.schedule?.weekday },
      weekend: { ...DEFAULT_SETTINGS.schedule.weekend, ...settings.schedule?.weekend },
    },
    sites: settings.sites ?? structuredClone(DEFAULT_SETTINGS.sites),
  };
}

export function saveSettings(settings) {
  return chrome.storage.sync.set({ settings });
}

export async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return { ...structuredClone(DEFAULT_STATE), ...state };
}

export function saveState(state) {
  return chrome.storage.local.set({ state });
}

// Expires a finished focus boost in place. Returns true if anything changed.
export function pruneFocus(state, now = Date.now()) {
  if (state.focusUntil !== null && state.focusUntil <= now) {
    state.focusUntil = null;
    return true;
  }
  return false;
}

// `domain` must always be the matchSite() result (the blocklist entry),
// never a raw hostname — grants and checks compare it with strict equality.
export function hasAllowance(state, tabId, domain) {
  return state.allowances[String(tabId)] === domain;
}

export function grantAllowance(state, tabId, domain) {
  state.allowances[String(tabId)] = domain;
}

// Returns true if an allowance was removed.
export function clearAllowance(state, tabId) {
  const key = String(tabId);
  if (key in state.allowances) {
    delete state.allowances[key];
    return true;
  }
  return false;
}

// Returns the matching blocklist entry for a hostname, or null.
export function matchSite(hostname, sites) {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  for (const [site, on] of Object.entries(sites)) {
    if (!on) continue;
    if (host === site || host.endsWith('.' + site)) return site;
  }
  return null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function configFor(schedule, day) {
  return day === 0 || day === 6 ? schedule.weekend : schedule.weekday;
}

// An overnight range (start > end, e.g. 21:00–02:00) belongs to the day it
// STARTS: Friday's weekday window keeps covering 00:00–02:00 Saturday even
// though Saturday uses the weekend config.
export function inSchedule(schedule, date = new Date()) {
  const t = date.getHours() * 60 + date.getMinutes();

  const today = configFor(schedule, date.getDay());
  if (today.active) {
    const start = toMinutes(today.start);
    const end = toMinutes(today.end);
    if (start === end) return true; // identical start/end means all day
    if (start < end ? t >= start && t < end : t >= start) return true;
  }

  const yesterday = configFor(schedule, (date.getDay() + 6) % 7);
  if (yesterday.active) {
    const start = toMinutes(yesterday.start);
    const end = toMinutes(yesterday.end);
    if (start > end && t < end) return true; // tail of yesterday's overnight window
  }

  return false;
}

// A focus boost arms Pause even outside schedule and even if the master toggle is off.
export function isArmed(settings, state, now = new Date()) {
  if (state.focusUntil !== null && state.focusUntil > now.getTime()) return true;
  if (!settings.enabled) return false;
  return inSchedule(settings.schedule, now);
}

export function formatRemaining(ts, now = Date.now()) {
  const mins = Math.max(0, Math.ceil((ts - now) / 60000));
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

// Turns free-form user input ("https://www.News.YCombinator.com/item?id=1")
// into a bare domain ("news.ycombinator.com"), or null if it isn't one.
export function normalizeDomain(input) {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  s = s.split(/[/?#]/)[0].split(':')[0];
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  return s;
}
