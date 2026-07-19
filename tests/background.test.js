import { beforeEach, describe, expect, it, vi } from 'vitest';

const ALL_DAY = { active: true, start: '00:00', end: '00:00' };
const OFF = { active: false, start: '09:00', end: '18:00' };

function makeChrome() {
  const sync = {};
  const local = {};
  const area = (store) => ({
    get: vi.fn(async (key) => (key in store ? { [key]: structuredClone(store[key]) } : {})),
    set: vi.fn(async (obj) => Object.assign(store, structuredClone(obj))),
  });
  const chrome = {
    storage: { sync: area(sync), local: area(local) },
    webNavigation: {
      onBeforeNavigate: { addListener: vi.fn() },
      onCommitted: { addListener: vi.fn() },
    },
    tabs: {
      update: vi.fn(async () => ({})),
      goBack: vi.fn(async () => {}),
      onRemoved: { addListener: vi.fn() },
    },
    runtime: {
      getURL: (path) => `chrome-extension://test-id/${path}`,
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  };
  return { chrome, sync, local };
}

let chromeEnv;
let background;

async function setup({ settings, state } = {}) {
  chromeEnv = makeChrome();
  if (settings) chromeEnv.sync.settings = settings;
  if (state) chromeEnv.local.state = state;
  globalThis.chrome = chromeEnv.chrome;
  vi.resetModules();
  background = await import('../background.js');
}

const armedSettings = {
  enabled: true,
  schedule: { weekday: ALL_DAY, weekend: ALL_DAY },
  sites: { 'youtube.com': true, 'reddit.com': true },
};

const nav = (url, tabId = 1, frameId = 0) => ({ url, tabId, frameId });

function lastPauseRedirect() {
  const call = chromeEnv.chrome.tabs.update.mock.calls.at(-1);
  return call ? { tabId: call[0], url: call[1].url } : null;
}

beforeEach(() => setup({ settings: armedSettings }));

describe('navigation interception', () => {
  it('redirects a blocked site to the pause page with target and domain', async () => {
    await background.onNavigate(nav('https://www.youtube.com/watch?v=abc', 7));
    const redirect = lastPauseRedirect();
    expect(redirect.tabId).toBe(7);
    expect(redirect.url).toContain('pause/pause.html');
    expect(redirect.url).toContain(encodeURIComponent('https://www.youtube.com/watch?v=abc'));
    expect(redirect.url).toContain('domain=youtube.com');
  });

  it('ignores unlisted domains, subframes, and non-http schemes', async () => {
    await background.onNavigate(nav('https://example.com/', 1));
    await background.onNavigate(nav('https://youtube.com/', 1, 5));
    await background.onNavigate(nav('chrome://settings/', 1));
    await background.onNavigate(nav('not a url', 1));
    expect(chromeEnv.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('does not intercept when the master toggle is off', async () => {
    await setup({ settings: { ...armedSettings, enabled: false } });
    await background.onNavigate(nav('https://youtube.com/', 1));
    expect(chromeEnv.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('does not intercept outside schedule hours', async () => {
    await setup({ settings: { ...armedSettings, schedule: { weekday: OFF, weekend: OFF } } });
    await background.onNavigate(nav('https://youtube.com/', 1));
    expect(chromeEnv.chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('one-time pass (continue)', () => {
  const sender = { tab: { id: 7 } };

  it('grants a tab-scoped pass and navigates to the target', async () => {
    const result = await background.handleMessage(
      { type: 'continue', domain: 'youtube.com', target: 'https://youtube.com/feed' },
      sender,
    );
    expect(result.ok).toBe(true);
    expect(chromeEnv.local.state.allowances['7']).toBe('youtube.com');
    expect(lastPauseRedirect().url).toBe('https://youtube.com/feed');

    // Same tab, same domain: sails through.
    chromeEnv.chrome.tabs.update.mockClear();
    await background.onNavigate(nav('https://youtube.com/feed', 7));
    expect(chromeEnv.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('does not cover another tab or another blocked domain', async () => {
    await background.handleMessage(
      { type: 'continue', domain: 'youtube.com', target: 'https://youtube.com/' },
      sender,
    );
    chromeEnv.chrome.tabs.update.mockClear();

    await background.onNavigate(nav('https://youtube.com/', 8));
    expect(lastPauseRedirect().tabId).toBe(8);

    await background.onNavigate(nav('https://reddit.com/', 7));
    expect(lastPauseRedirect().tabId).toBe(7);
    expect(lastPauseRedirect().url).toContain('domain=reddit.com');
  });

  it('is spent by navigating off the domain', async () => {
    await background.handleMessage(
      { type: 'continue', domain: 'youtube.com', target: 'https://youtube.com/' },
      sender,
    );
    await background.onNavigate(nav('https://example.com/', 7));
    expect(chromeEnv.local.state.allowances['7']).toBeUndefined();

    chromeEnv.chrome.tabs.update.mockClear();
    await background.onNavigate(nav('https://youtube.com/', 7));
    expect(lastPauseRedirect()).not.toBeNull();
  });

  it('is spent by closing the tab', async () => {
    await background.handleMessage(
      { type: 'continue', domain: 'youtube.com', target: 'https://youtube.com/' },
      sender,
    );
    await background.onTabRemoved(7);
    expect(chromeEnv.local.state.allowances['7']).toBeUndefined();
  });

  it('rejects non-web targets and non-tab senders', async () => {
    const bad = await background.handleMessage(
      { type: 'continue', domain: 'youtube.com', target: 'javascript:alert(1)' },
      sender,
    );
    expect(bad.ok).toBe(false);
    const noTab = await background.handleMessage(
      { type: 'continue', domain: 'youtube.com', target: 'https://youtube.com/' },
      {},
    );
    expect(noTab.ok).toBe(false);
    expect(chromeEnv.chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('focus boost', () => {
  it('arms interception even when the master toggle is off', async () => {
    await setup({ settings: { ...armedSettings, enabled: false } });
    await background.handleMessage({ type: 'focus', hours: 2 }, {});
    await background.onNavigate(nav('https://youtube.com/', 1));
    expect(lastPauseRedirect().url).toContain('pause/pause.html');
  });

  it('cancelFocus disarms again', async () => {
    await setup({ settings: { ...armedSettings, enabled: false } });
    await background.handleMessage({ type: 'focus', hours: 2 }, {});
    await background.handleMessage({ type: 'cancelFocus' }, {});
    await background.onNavigate(nav('https://youtube.com/', 1));
    expect(lastPauseRedirect()).toBeNull();
  });

  it('rejects nonsense durations', async () => {
    for (const hours of [0, -1, 25, 'lots', NaN]) {
      const result = await background.handleMessage({ type: 'focus', hours }, {});
      expect(result.ok).toBe(false);
    }
  });

  it('shows time remaining on the badge and clears it on cancel', async () => {
    await background.handleMessage({ type: 'focus', hours: 2 }, {});
    expect(chromeEnv.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '2h' });
    await background.handleMessage({ type: 'cancelFocus' }, {});
    expect(chromeEnv.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  it('starting a boost wipes existing passes', async () => {
    await background.handleMessage(
      { type: 'continue', domain: 'youtube.com', target: 'https://youtube.com/' },
      { tab: { id: 7 } },
    );
    await background.handleMessage({ type: 'focus', hours: 1 }, {});
    expect(chromeEnv.local.state.allowances).toEqual({});
  });
});

describe('lifecycle', () => {
  it('browser startup wipes stale passes and recreates the badge alarm', async () => {
    await setup({
      settings: armedSettings,
      state: { focusUntil: null, allowances: { 3: 'youtube.com', 9: 'reddit.com' } },
    });
    await background.onBrowserStartup();
    expect(chromeEnv.local.state.allowances).toEqual({});
    expect(chromeEnv.chrome.alarms.create).toHaveBeenCalledWith('tick', { periodInMinutes: 1 });
  });

  it('state writes from concurrent handlers do not lose each other', async () => {
    await background.handleMessage(
      { type: 'continue', domain: 'reddit.com', target: 'https://reddit.com/' },
      { tab: { id: 8 } },
    );
    // Tab 8 closes at the same moment tab 7's pause page sends continue.
    await Promise.all([
      background.onTabRemoved(8),
      background.handleMessage(
        { type: 'continue', domain: 'youtube.com', target: 'https://youtube.com/' },
        { tab: { id: 7 } },
      ),
    ]);
    expect(chromeEnv.local.state.allowances).toEqual({ 7: 'youtube.com' });
  });

  it('back uses tab history and falls back to a new tab page', async () => {
    const sender = { tab: { id: 7 } };
    await background.handleMessage({ type: 'back' }, sender);
    expect(chromeEnv.chrome.tabs.goBack).toHaveBeenCalledWith(7);

    chromeEnv.chrome.tabs.goBack.mockRejectedValueOnce(new Error('no history'));
    await background.handleMessage({ type: 'back' }, sender);
    expect(lastPauseRedirect().url).toBe('chrome://newtab/');
  });

  it('getStatus reports armed state and focus expiry', async () => {
    const status = await background.handleMessage({ type: 'getStatus' }, {});
    expect(status).toMatchObject({ armed: true, enabled: true, inSchedule: true, focusUntil: null });
  });

  it('registers all its listeners at the top level', async () => {
    expect(chromeEnv.chrome.webNavigation.onBeforeNavigate.addListener).toHaveBeenCalledWith(
      background.onNavigate,
    );
    // onCommitted too: server-side redirects and prerenders never re-fire
    // onBeforeNavigate with the final URL.
    expect(chromeEnv.chrome.webNavigation.onCommitted.addListener).toHaveBeenCalledWith(
      background.onNavigate,
    );
    expect(chromeEnv.chrome.tabs.onRemoved.addListener).toHaveBeenCalledWith(background.onTabRemoved);
    expect(chromeEnv.chrome.runtime.onMessage.addListener).toHaveBeenCalled();
    expect(chromeEnv.chrome.runtime.onStartup.addListener).toHaveBeenCalledWith(
      background.onBrowserStartup,
    );
    expect(chromeEnv.chrome.runtime.onInstalled.addListener).toHaveBeenCalled();
    expect(chromeEnv.chrome.alarms.onAlarm.addListener).toHaveBeenCalled();
  });
});
