// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../../testing/chrome-mock';
import { collapsible } from './collapsible';

let section: HTMLElement;
let toggle: HTMLButtonElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  installChrome();
  document.body.replaceChildren();
  section = document.createElement('section');
  toggle = document.createElement('button');
  toggle.setAttribute('aria-label', 'Collapse activity');
  document.body.append(section, toggle);
});
afterEach(() => vi.unstubAllGlobals());

describe('collapsible', () => {
  it('collapses and expands, says which in aria-expanded and the label, and remembers it', async () => {
    const changes: boolean[] = [];
    collapsible({ section, toggle, storageKey: 'activityCollapsed', onChange: (collapsed) => changes.push(collapsed) });
    await flush();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(section.classList.contains('collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Expand activity');
    expect(toggle.title).toBe('Expand activity');
    expect(await chrome.storage.local.get('activityCollapsed')).toEqual({ activityCollapsed: true });
    toggle.click();
    expect(toggle.getAttribute('aria-label')).toBe('Collapse activity');
    expect(changes).toEqual([false, true, false]);
  });

  it('starts collapsed when it was left that way', async () => {
    await chrome.storage.local.set({ activityCollapsed: true });
    collapsible({ section, toggle, storageKey: 'activityCollapsed' });
    await flush();
    expect(section.classList.contains('collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
