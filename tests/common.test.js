import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  clearAllowance,
  formatRemaining,
  getSettings,
  grantAllowance,
  hasAllowance,
  inSchedule,
  isArmed,
  matchSite,
  normalizeDomain,
  pruneFocus,
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
