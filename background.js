import {
  accrueSession,
  clearAllowance,
  getSettings,
  getState,
  grantAllowance,
  hasAllowance,
  inSchedule,
  isArmed,
  localDayKey,
  matchSite,
  pruneFocus,
  saveState,
  timedDomain,
} from './shared/common.js';

// All state writes go through this queue: concurrent handlers (navigation,
// tab close, messages) would otherwise interleave get→mutate→set and lose
// each other's changes. The queue only needs to cover one worker instance —
// that is exactly the scope in which handlers can run concurrently.
let stateQueue = Promise.resolve();
function mutateState(fn) {
  const run = stateQueue.then(async () => {
    const state = await getState();
    const result = fn(state);
    await saveState(state);
    return result;
  });
  stateQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Read-only load. Expired focus boosts are pruned in memory only — isArmed
// ignores them anyway, so persisting the cleanup isn't worth a write.
async function loadAll() {
  const [settings, state] = await Promise.all([getSettings(), getState()]);
  pruneFocus(state);
  return { settings, state };
}

// Tracked in memory, not storage: chrome.idle only tells us about changes
// going forward, so this reflects state since the worker last woke up.
// Defaulting to 'active' is safe — the next real idle/active event corrects it.
let idleState = 'active';

// The domain eligible for budget accrual right now, or null: the active tab
// of the focused window, on a timed site, while the user isn't idle. This is
// what decision #1 ("active focused tab only") boils down to.
async function resolveActiveDomain(settings) {
  if (idleState !== 'active') return null;
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    return null;
  }
  const tab = tabs[0];
  if (!tab?.url) return null;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused) return null; // Chrome itself may not have OS focus
  } catch {
    return null;
  }
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return timedDomain(settings, url.hostname);
}

// Flushes whatever session is active into usage, then starts a fresh one iff
// the currently active tab is on a timed site. Safe to call repeatedly —
// each call only ever accounts for time since the previous flush.
export async function syncActiveSession() {
  const settings = await getSettings();
  const domain = await resolveActiveDomain(settings);
  const now = Date.now();
  const dayKey = localDayKey(new Date(now));
  await mutateState((state) => {
    accrueSession(state, now, dayKey);
    state.session = domain ? { domain, startedAt: now } : null;
  });
}

async function flushAndClearSession() {
  const now = Date.now();
  const dayKey = localDayKey(new Date(now));
  await mutateState((state) => {
    accrueSession(state, now, dayKey);
    state.session = null;
  });
}

// Runs on both onBeforeNavigate and onCommitted: the former alone misses
// server-side redirect chains (youtu.be → youtube.com) and prerendered
// pages, which never re-fire it. The check is idempotent, so seeing the
// same navigation twice is harmless.
export async function onNavigate(details) {
  if (details.frameId !== 0) return;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const { settings, state } = await loadAll();
  const domain = matchSite(url.hostname, settings.sites);

  // Leaving the domain a pass was granted for spends the pass.
  const passDomain = state.allowances[String(details.tabId)];
  if (passDomain !== undefined && passDomain !== domain) {
    await mutateState((s) => clearAllowance(s, details.tabId));
  }

  if (!domain) return;
  if (hasAllowance(state, details.tabId, domain)) return;
  if (!isArmed(settings, state)) return;

  const pauseUrl =
    chrome.runtime.getURL('pause/pause.html') +
    `?target=${encodeURIComponent(details.url)}&domain=${encodeURIComponent(domain)}`;
  try {
    await chrome.tabs.update(details.tabId, { url: pauseUrl });
  } catch {
    // Tab may have closed mid-navigation.
  }
}

export async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'continue': {
      if (!sender.tab) return { ok: false };
      let target;
      try {
        target = new URL(msg.target);
      } catch {
        return { ok: false };
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return { ok: false };
      const settings = await getSettings();
      if (matchSite(target.hostname, settings.sites) !== msg.domain) return { ok: false };
      await mutateState((s) => grantAllowance(s, sender.tab.id, msg.domain));
      try {
        await chrome.tabs.update(sender.tab.id, { url: msg.target });
      } catch {
        // Pause tab closed before we could navigate it; the pass just
        // leaks until startup cleanup, which is harmless.
      }
      return { ok: true };
    }
    case 'back': {
      if (!sender.tab) return { ok: false };
      try {
        await chrome.tabs.goBack(sender.tab.id);
      } catch {
        try {
          await chrome.tabs.update(sender.tab.id, { url: 'chrome://newtab/' });
        } catch {}
      }
      return { ok: true };
    }
    case 'focus': {
      const hours = Number(msg.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return { ok: false };
      await mutateState((s) => {
        s.focusUntil = Date.now() + hours * 3_600_000;
        s.allowances = {}; // a focus boost overrides everything, passes included
      });
      await updateBadge();
      return { ok: true };
    }
    case 'cancelFocus': {
      await mutateState((s) => {
        s.focusUntil = null;
      });
      await updateBadge();
      return { ok: true };
    }
    case 'getStatus': {
      const { settings, state } = await loadAll();
      return {
        armed: isArmed(settings, state),
        enabled: settings.enabled,
        inSchedule: inSchedule(settings.schedule),
        focusUntil: state.focusUntil,
      };
    }
  }
  return { ok: false };
}

export async function onTabRemoved(tabId) {
  await mutateState((s) => clearAllowance(s, tabId));
}

// Session restore assigns new tab ids, so passes from the previous
// session can never match again — drop them all. Alarms are not
// guaranteed to survive a browser restart, so recreate the tick too.
export async function onBrowserStartup() {
  await mutateState((s) => {
    s.allowances = {};
  });
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  chrome.idle.setDetectionInterval(60);
  await updateBadge();
}

export async function updateBadge() {
  const { state } = await loadAll();
  if (state.focusUntil !== null) {
    const mins = Math.max(0, Math.ceil((state.focusUntil - Date.now()) / 60_000));
    const text = mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m`;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#4F46E5' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(onNavigate);
chrome.webNavigation.onCommitted.addListener(onNavigate);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, () => sendResponse({ ok: false }));
  return true; // keep the message channel open for the async response
});
chrome.tabs.onActivated.addListener(() => syncActiveSession());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  syncActiveSession();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  return windowId === chrome.windows.WINDOW_ID_NONE ? flushAndClearSession() : syncActiveSession();
});
chrome.idle.onStateChanged.addListener((newState) => {
  idleState = newState;
  return newState === 'active' ? syncActiveSession() : flushAndClearSession();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') {
    syncActiveSession().then(updateBadge);
  }
});
chrome.runtime.onStartup.addListener(onBrowserStartup);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  chrome.idle.setDetectionInterval(60);
  updateBadge();
});
