// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../../testing/chrome-mock';
import { loadPanelHtml } from '../../testing/fixtures';
import { followAppearance } from './appearance';

let fake: ReturnType<typeof installChrome>;
let dark: boolean;
let mediaListeners: (() => void)[];
let applied: string[];

const page = () => document.documentElement.dataset;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  fake = installChrome();
  loadPanelHtml();
  dark = true;
  mediaListeners = [];
  applied = [];
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return dark;
    },
    addEventListener: (_: string, listener: () => void) => mediaListeners.push(listener),
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('followAppearance', () => {
  it('applies the saved theme and density to the page, and hands the theme to the caller', async () => {
    fake.storage.local.prefs = { theme: 'light', density: 'compact' };
    followAppearance((theme) => applied.push(theme));
    expect(page().theme).toBeUndefined();
    await flush();
    expect(page().theme).toBe('light');
    expect(page().density).toBe('compact');
    expect(applied).toEqual(['light']);
  });

  it('follows the operating system when the theme is system, and again when the system changes', async () => {
    followAppearance((theme) => applied.push(theme));
    await flush();
    expect(page().theme).toBe('dark');
    expect(page().density).toBe('comfortable');
    dark = false;
    mediaListeners.forEach((listener) => listener());
    expect(page().theme).toBe('light');
    expect(applied).toEqual(['dark', 'light']);
  });

  it('ignores a system change that arrives before the preferences have loaded', async () => {
    followAppearance((theme) => applied.push(theme));
    mediaListeners.forEach((listener) => listener());
    expect(page().theme).toBeUndefined();
    expect(applied).toEqual([]);
    await flush();
    expect(applied).toEqual(['dark']);
  });

  it('applies a change made in settings at once, and keeps following the system for a return to system', async () => {
    followAppearance((theme) => applied.push(theme));
    await flush();
    fake.events.storage.onChanged.emit({ prefs: { newValue: { theme: 'light', density: 'compact' } } }, 'local');
    expect(page().theme).toBe('light');
    expect(page().density).toBe('compact');
    // A fixed theme does not move with the system.
    dark = false;
    mediaListeners.forEach((listener) => listener());
    expect(page().theme).toBe('light');
    fake.events.storage.onChanged.emit({ prefs: { newValue: { theme: 'system', density: 'compact' } } }, 'local');
    expect(page().theme).toBe('light');
    dark = true;
    mediaListeners.forEach((listener) => listener());
    expect(page().theme).toBe('dark');
    expect(applied).toEqual(['dark', 'light', 'light', 'light', 'dark']);
  });

  it('leaves the page alone for a change to another key or another storage area', async () => {
    followAppearance((theme) => applied.push(theme));
    await flush();
    fake.events.storage.onChanged.emit({ listWidth: { newValue: 300 } }, 'local');
    fake.events.storage.onChanged.emit({ prefs: { newValue: { theme: 'light', density: 'compact' } } }, 'session');
    expect(page().theme).toBe('dark');
    expect(applied).toEqual(['dark']);
  });
});
