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
  // Parallel map to `sites`, keyed by the same domain: domain -> daily minutes
  // (integer > 0). Absent/0 means no timer for that site. Kept separate so
  // matchSite() and the on/off toggle logic never need to know timers exist.
  siteTimers: {},
  overBudgetMult: 4,
  bypassOpenSeconds: 5,
  bypassClicks: 4,
};

export const DEFAULT_STATE = {
  focusUntil: null,
  // One-time passes: tab id (as string) -> domain allowed in that tab.
  allowances: {},
  // Seconds spent per timed domain for the local day.
  usage: { day: null, byDomain: {} },
  // Active accrual session, timestamp-based so it survives the MV3 worker
  // being torn down: elapsed is always computed as `now - startedAt` on the
  // next flush, never with a live counter.
  session: null,
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
    siteTimers: settings.siteTimers ?? {},
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

// 'YYYY-MM-DD' in local time — the boundary a day's usage rolls over on.
export function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Zeroes usage in place when the local day has rolled over. Returns true if
// it did.
export function rolloverUsage(usage, dayKey) {
  if (usage.day === dayKey) return false;
  usage.day = dayKey;
  usage.byDomain = {};
  return true;
}

// Flushes the active session's elapsed time into usage.byDomain, then
// restarts the session's clock from `now` (flush-and-continue) so the next
// flush only ever accounts for the time since the last one. A no-op if
// there's no active session.
export function accrueSession(state, now, dayKey) {
  rolloverUsage(state.usage, dayKey);
  if (!state.session) return;
  const domain = state.session.domain;
  const elapsedSeconds = Math.max(0, (now - state.session.startedAt) / 1000);
  state.usage.byDomain[domain] = (state.usage.byDomain[domain] ?? 0) + elapsedSeconds;
  state.session.startedAt = now;
}

// The blocklist entry for `hostname`, but only if it also has a daily timer
// configured — the domain accrual and over-budget escalation care about.
export function timedDomain(settings, hostname) {
  const site = matchSite(hostname, settings.sites);
  if (!site) return null;
  return settings.siteTimers?.[site] > 0 ? site : null;
}

export function usageSeconds(state, domain) {
  return state.usage.byDomain[domain] ?? 0;
}

export function budgetSeconds(settings, domain) {
  return (settings.siteTimers?.[domain] ?? 0) * 60;
}

export function isOverBudget(settings, state, domain) {
  const budget = budgetSeconds(settings, domain);
  if (budget <= 0) return false;
  return usageSeconds(state, domain) >= budget;
}

export function remainingSeconds(settings, state, domain) {
  return Math.max(0, budgetSeconds(settings, domain) - usageSeconds(state, domain));
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
