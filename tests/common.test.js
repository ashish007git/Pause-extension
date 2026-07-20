import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  accrueSession,
  budgetSeconds,
  clearAllowance,
  formatRemaining,
  getSettings,
  grantAllowance,
  hasAllowance,
  inSchedule,
  isArmed,
  isOverBudget,
  localDayKey,
  matchSite,
  normalizeDomain,
  pruneFocus,
  remainingSeconds,
  rolloverUsage,
  timedDomain,
  usageSeconds,
} from '../shared/common.js';

// Local dates: 2026-07-13 Mon, 2026-07-15 Wed, 2026-07-18 Sat, 2026-07-19 Sun.
const monday = (h, m = 0) => new Date(2026, 6, 13, h, m);
const wednesday = (h, m = 0) => new Date(2026, 6, 15, h, m);
const saturday = (h, m = 0) => new Date(2026, 6, 18, h, m);
const sunday = (h, m = 0) => new Date(2026, 6, 19, h, m);

const schedule = (weekday, weekend = { active: false, start: '09:00', end: '18:00' }) => ({
  weekday,
  weekend,
});

describe('inSchedule', () => {
  const workHours = { active: true, start: '09:00', end: '18:00' };

  it('is armed inside weekday work hours', () => {
    expect(inSchedule(schedule(workHours), wednesday(12))).toBe(true);
  });

  it('is off before start and after end', () => {
    expect(inSchedule(schedule(workHours), wednesday(8, 59))).toBe(false);
    expect(inSchedule(schedule(workHours), wednesday(18, 0))).toBe(false);
  });

  it('start boundary is inclusive, end boundary exclusive', () => {
    expect(inSchedule(schedule(workHours), wednesday(9, 0))).toBe(true);
    expect(inSchedule(schedule(workHours), wednesday(17, 59))).toBe(true);
  });

  it('uses the weekend config on Saturdays', () => {
    expect(inSchedule(schedule(workHours), saturday(12))).toBe(false);
    const weekendOn = { active: true, start: '10:00', end: '14:00' };
    expect(inSchedule(schedule(workHours, weekendOn), saturday(12))).toBe(true);
    expect(inSchedule(schedule(workHours, weekendOn), saturday(15))).toBe(false);
  });

  it('ignores the range when the day type is inactive', () => {
    expect(inSchedule(schedule({ active: false, start: '00:00', end: '23:59' }), wednesday(12))).toBe(false);
  });

  it('handles overnight ranges', () => {
    const night = { active: true, start: '21:00', end: '02:00' };
    expect(inSchedule(schedule(night), wednesday(23))).toBe(true);
    expect(inSchedule(schedule(night), wednesday(1))).toBe(true);
    expect(inSchedule(schedule(night), wednesday(12))).toBe(false);
    expect(inSchedule(schedule(night), wednesday(2, 0))).toBe(false);
  });

  it('treats start == end as all day', () => {
    const allDay = { active: true, start: '09:00', end: '09:00' };
    expect(inSchedule(schedule(allDay), wednesday(3))).toBe(true);
    expect(inSchedule(schedule(allDay), wednesday(22))).toBe(true);
  });

  it('uses the weekend config on Sundays', () => {
    expect(inSchedule(schedule(workHours), sunday(12))).toBe(false);
    const weekendOn = { active: true, start: '10:00', end: '14:00' };
    expect(inSchedule(schedule(workHours, weekendOn), sunday(12))).toBe(true);
  });

  it('honors non-zero minutes in the range', () => {
    const halfHours = { active: true, start: '09:30', end: '17:45' };
    expect(inSchedule(schedule(halfHours), wednesday(9, 15))).toBe(false);
    expect(inSchedule(schedule(halfHours), wednesday(9, 30))).toBe(true);
    expect(inSchedule(schedule(halfHours), wednesday(17, 44))).toBe(true);
    expect(inSchedule(schedule(halfHours), wednesday(17, 45))).toBe(false);
  });

  it("an overnight window belongs to the day it starts, across the weekday/weekend boundary", () => {
    const night = { active: true, start: '21:00', end: '02:00' };
    // Friday's weekday window still covers early Saturday...
    expect(inSchedule(schedule(night), saturday(1))).toBe(true);
    // ...but not Saturday's own evening or later hours.
    expect(inSchedule(schedule(night), saturday(3))).toBe(false);
    expect(inSchedule(schedule(night), saturday(23))).toBe(false);
    // Sunday's weekend window covers early Monday.
    const weekendNight = schedule({ active: false, start: '09:00', end: '18:00' }, night);
    expect(inSchedule(weekendNight, monday(1))).toBe(true);
    expect(inSchedule(weekendNight, monday(23))).toBe(false);
  });
});

describe('matchSite', () => {
  const sites = { 'youtube.com': true, 'reddit.com': false, 'x.com': true };

  it('matches exact domains and subdomains', () => {
    expect(matchSite('youtube.com', sites)).toBe('youtube.com');
    expect(matchSite('music.youtube.com', sites)).toBe('youtube.com');
  });

  it('strips www and ignores case', () => {
    expect(matchSite('www.youtube.com', sites)).toBe('youtube.com');
    expect(matchSite('WWW.YouTube.COM', sites)).toBe('youtube.com');
  });

  it('ignores disabled entries', () => {
    expect(matchSite('reddit.com', sites)).toBeNull();
  });

  it('does not match unrelated or suffix-similar hosts', () => {
    expect(matchSite('example.com', sites)).toBeNull();
    expect(matchSite('notyoutube.com', sites)).toBeNull();
    expect(matchSite('youtube.com.evil.net', sites)).toBeNull();
  });

  it('is not bypassed by a trailing-dot FQDN', () => {
    expect(matchSite('youtube.com.', sites)).toBe('youtube.com');
    expect(matchSite('www.youtube.com.', sites)).toBe('youtube.com');
  });
});

describe('isArmed', () => {
  const base = {
    ...DEFAULT_SETTINGS,
    schedule: schedule({ active: true, start: '09:00', end: '18:00' }),
  };
  const idle = { focusUntil: null, allowances: {} };

  it('follows the schedule when enabled', () => {
    expect(isArmed(base, idle, wednesday(12))).toBe(true);
    expect(isArmed(base, idle, wednesday(20))).toBe(false);
  });

  it('is off when the master toggle is off', () => {
    expect(isArmed({ ...base, enabled: false }, idle, wednesday(12))).toBe(false);
  });

  it('focus boost arms outside schedule and even when disabled', () => {
    const now = wednesday(20);
    const boosted = { focusUntil: now.getTime() + 3_600_000, allowances: {} };
    expect(isArmed(base, boosted, now)).toBe(true);
    expect(isArmed({ ...base, enabled: false }, boosted, now)).toBe(true);
  });

  it('an expired focus boost does not arm', () => {
    const now = wednesday(20);
    const stale = { focusUntil: now.getTime() - 1, allowances: {} };
    expect(isArmed(base, stale, now)).toBe(false);
  });

  it('a boost expiring exactly now does not arm (matches pruneFocus)', () => {
    const now = wednesday(20);
    const state = { focusUntil: now.getTime(), allowances: {} };
    expect(isArmed(base, state, now)).toBe(false);
    expect(pruneFocus(state, now.getTime())).toBe(true);
  });
});

describe('pruneFocus', () => {
  it('clears an expired focus boost and reports the change', () => {
    const state = { focusUntil: 1000, allowances: {} };
    expect(pruneFocus(state, 2000)).toBe(true);
    expect(state.focusUntil).toBeNull();
  });

  it('keeps an active focus boost', () => {
    const state = { focusUntil: 3000, allowances: {} };
    expect(pruneFocus(state, 2000)).toBe(false);
    expect(state.focusUntil).toBe(3000);
  });

  it('is a no-op when there is no focus boost', () => {
    expect(pruneFocus({ focusUntil: null, allowances: {} }, 2000)).toBe(false);
  });
});

describe('getSettings (storage merge)', () => {
  function stubStorage(stored) {
    globalThis.chrome = {
      storage: {
        sync: { get: async () => (stored === undefined ? {} : { settings: stored }) },
      },
    };
  }

  it('returns full defaults when nothing is stored', async () => {
    stubStorage(undefined);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('stored sites are taken as-is: deleted presets stay deleted', async () => {
    stubStorage({ sites: { 'example.com': true } });
    const settings = await getSettings();
    expect(settings.sites).toEqual({ 'example.com': true });
    expect(settings.sites['youtube.com']).toBeUndefined();
  });

  it('missing scalar and schedule fields fall back to defaults', async () => {
    stubStorage({ enabled: false, schedule: { weekday: { start: '10:00' } } });
    const settings = await getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.pauseSeconds).toBe(DEFAULT_SETTINGS.pauseSeconds);
    expect(settings.schedule.weekday).toEqual({ active: true, start: '10:00', end: '18:00' });
    expect(settings.schedule.weekend).toEqual(DEFAULT_SETTINGS.schedule.weekend);
  });

  it('stored siteTimers are taken as-is; missing falls back to {}', async () => {
    stubStorage({ siteTimers: { 'youtube.com': 30 } });
    expect((await getSettings()).siteTimers).toEqual({ 'youtube.com': 30 });
    stubStorage({ enabled: false });
    expect((await getSettings()).siteTimers).toEqual({});
  });
});

describe('allowances (one-time tab passes)', () => {
  it('grant/has/clear round-trip, keyed by tab and domain', () => {
    const state = { focusUntil: null, allowances: {} };
    grantAllowance(state, 42, 'youtube.com');
    expect(hasAllowance(state, 42, 'youtube.com')).toBe(true);
    expect(hasAllowance(state, 42, 'reddit.com')).toBe(false);
    expect(hasAllowance(state, 7, 'youtube.com')).toBe(false);
    expect(clearAllowance(state, 42)).toBe(true);
    expect(hasAllowance(state, 42, 'youtube.com')).toBe(false);
    expect(clearAllowance(state, 42)).toBe(false);
  });

  it('a new pass in the same tab replaces the old one', () => {
    const state = { focusUntil: null, allowances: {} };
    grantAllowance(state, 42, 'youtube.com');
    grantAllowance(state, 42, 'reddit.com');
    expect(hasAllowance(state, 42, 'youtube.com')).toBe(false);
    expect(hasAllowance(state, 42, 'reddit.com')).toBe(true);
  });
});

describe('formatRemaining', () => {
  it('formats minutes and hours', () => {
    expect(formatRemaining(30 * 60000, 0)).toBe('30m');
    expect(formatRemaining(60 * 60000, 0)).toBe('1h');
    expect(formatRemaining(90 * 60000, 0)).toBe('1h 30m');
  });

  it('rounds up partial minutes and floors at zero', () => {
    expect(formatRemaining(61_000, 0)).toBe('2m');
    expect(formatRemaining(0, 1000)).toBe('0m');
  });
});

describe('localDayKey', () => {
  it('formats in local time, zero-padded', () => {
    expect(localDayKey(new Date(2026, 6, 5, 23, 59))).toBe('2026-07-05');
    expect(localDayKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});

describe('rolloverUsage', () => {
  it('is a no-op when the day has not changed', () => {
    const usage = { day: '2026-07-19', byDomain: { 'youtube.com': 42 } };
    expect(rolloverUsage(usage, '2026-07-19')).toBe(false);
    expect(usage.byDomain).toEqual({ 'youtube.com': 42 });
  });

  it('resets byDomain and stamps the new day when it changed', () => {
    const usage = { day: '2026-07-19', byDomain: { 'youtube.com': 42 } };
    expect(rolloverUsage(usage, '2026-07-20')).toBe(true);
    expect(usage.day).toBe('2026-07-20');
    expect(usage.byDomain).toEqual({});
  });

  it('stamps the day when there was none yet, without clearing (nothing to clear)', () => {
    const usage = { day: null, byDomain: {} };
    expect(rolloverUsage(usage, '2026-07-20')).toBe(true);
    expect(usage.day).toBe('2026-07-20');
  });
});

describe('accrueSession', () => {
  it('adds elapsed seconds to the session domain and restarts the clock', () => {
    const state = {
      usage: { day: '2026-07-20', byDomain: {} },
      session: { domain: 'youtube.com', startedAt: 1000 },
    };
    accrueSession(state, 1000 + 30_000, '2026-07-20');
    expect(state.usage.byDomain['youtube.com']).toBe(30);
    expect(state.session.startedAt).toBe(31000);

    // Flush again after another 10s: only the new delta is added.
    accrueSession(state, 31000 + 10_000, '2026-07-20');
    expect(state.usage.byDomain['youtube.com']).toBe(40);
  });

  it('is a no-op when there is no active session (still applies rollover)', () => {
    const state = { usage: { day: '2026-07-19', byDomain: { 'x.com': 5 } }, session: null };
    accrueSession(state, 2000, '2026-07-20');
    expect(state.session).toBeNull();
    expect(state.usage.day).toBe('2026-07-20');
    expect(state.usage.byDomain).toEqual({});
  });

  it('zeroes prior usage on a day rollover before accruing the new session', () => {
    const state = {
      usage: { day: '2026-07-19', byDomain: { 'youtube.com': 999 } },
      session: { domain: 'youtube.com', startedAt: 1000 },
    };
    accrueSession(state, 1000 + 5_000, '2026-07-20');
    expect(state.usage.byDomain['youtube.com']).toBe(5);
  });
});

describe('timedDomain', () => {
  const settings = {
    sites: { 'youtube.com': true, 'reddit.com': true, 'x.com': false },
    siteTimers: { 'youtube.com': 30, 'reddit.com': 0 },
  };

  it('returns the site only when it is paused and has a positive timer', () => {
    expect(timedDomain(settings, 'www.youtube.com')).toBe('youtube.com');
  });

  it('returns null when there is no timer set', () => {
    expect(timedDomain(settings, 'reddit.com')).toBeNull();
    expect(timedDomain({ ...settings, siteTimers: {} }, 'youtube.com')).toBeNull();
  });

  it('returns null when the site is not paused at all', () => {
    expect(timedDomain(settings, 'x.com')).toBeNull();
    expect(timedDomain(settings, 'example.com')).toBeNull();
  });
});

describe('budget helpers', () => {
  const settings = { siteTimers: { 'youtube.com': 1 } }; // 1 minute = 60s

  it('budgetSeconds converts minutes to seconds; 0 for untimed domains', () => {
    expect(budgetSeconds(settings, 'youtube.com')).toBe(60);
    expect(budgetSeconds(settings, 'reddit.com')).toBe(0);
  });

  it('usageSeconds reads byDomain, defaulting to 0', () => {
    const state = { usage: { day: null, byDomain: { 'youtube.com': 12 } } };
    expect(usageSeconds(state, 'youtube.com')).toBe(12);
    expect(usageSeconds(state, 'reddit.com')).toBe(0);
  });

  it('isOverBudget is false under budget, true at/after the boundary', () => {
    const under = { usage: { day: null, byDomain: { 'youtube.com': 59 } } };
    const atBoundary = { usage: { day: null, byDomain: { 'youtube.com': 60 } } };
    expect(isOverBudget(settings, under, 'youtube.com')).toBe(false);
    expect(isOverBudget(settings, atBoundary, 'youtube.com')).toBe(true);
  });

  it('isOverBudget is always false for an untimed domain', () => {
    const state = { usage: { day: null, byDomain: { 'reddit.com': 10_000 } } };
    expect(isOverBudget(settings, state, 'reddit.com')).toBe(false);
  });

  it('remainingSeconds counts down to zero and floors there', () => {
    const state = { usage: { day: null, byDomain: { 'youtube.com': 40 } } };
    expect(remainingSeconds(settings, state, 'youtube.com')).toBe(20);
    const over = { usage: { day: null, byDomain: { 'youtube.com': 90 } } };
    expect(remainingSeconds(settings, over, 'youtube.com')).toBe(0);
  });
});

describe('normalizeDomain', () => {
  it('cleans URLs down to bare domains', () => {
    expect(normalizeDomain('https://www.News.YCombinator.com/item?id=1')).toBe('news.ycombinator.com');
    expect(normalizeDomain('  youtube.com  ')).toBe('youtube.com');
    expect(normalizeDomain('reddit.com:443/r/all#top')).toBe('reddit.com');
  });

  it('rejects non-domains', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('-bad-.com')).toBeNull();
  });
});
