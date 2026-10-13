// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createPalette, type PaletteItem } from '../src/palette';

const item = (label: string, run = vi.fn(), extra: Partial<PaletteItem> = {}): PaletteItem => ({ kind: 'Workspace', label, run, ...extra });

let onClose: Mock<() => void>;
beforeEach(() => {
  document.body.innerHTML = `<div id="palette" hidden><input id="palette-input" /><ul id="palette-results"></ul></div>`;
  onClose = vi.fn<() => void>();
  Element.prototype.scrollIntoView = vi.fn();
});

const input = () => document.getElementById('palette-input') as HTMLInputElement;
const root = () => document.getElementById('palette') as HTMLElement;
const rows = () => [...document.querySelectorAll('#palette-results li')];
const labels = () => rows().map((row) => row.querySelector('.palette-label')?.textContent);
const activeLabel = () => document.querySelector('.palette-row.active .palette-label')?.textContent;
const type = (text: string) => {
  input().value = text;
  input().dispatchEvent(new Event('input'));
};
const press = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init });
  input().dispatchEvent(event);
  return event;
};

describe('opening', () => {
  it('shows every item, with its kind and hint, and focuses the box', () => {
    const palette = createPalette(() => [item('acme/app', vi.fn(), { hint: '~/acme' }), item('acme/api')], onClose);
    palette.open();
    expect(palette.isOpen).toBe(true);
    expect(root().hidden).toBe(false);
    expect(labels()).toEqual(['acme/app', 'acme/api']);
    expect(rows()[0]!.querySelector('.palette-kind')?.textContent).toBe('Workspace');
    expect(rows()[0]!.querySelector('.palette-hint')?.textContent).toBe('~/acme');
    expect(rows()[1]!.querySelector('.palette-hint')).toBeNull();
    expect(document.activeElement).toBe(input());
    expect(activeLabel()).toBe('acme/app');
  });

  it('reads the items again each time it opens, and starts with an empty box', () => {
    let items = [item('first')];
    const palette = createPalette(() => items, onClose);
    palette.open();
    type('fir');
    palette.close();
    items = [item('second')];
    palette.open();
    expect(input().value).toBe('');
    expect(labels()).toEqual(['second']);
  });

  it('ignores a second open while open', () => {
    const items = vi.fn(() => [item('a')]);
    const palette = createPalette(items, onClose);
    palette.open();
    palette.open();
    expect(items).toHaveBeenCalledTimes(1);
  });
});

describe('searching', () => {
  it('filters as you type, best match first, matching the kind too', () => {
    const palette = createPalette(() => [item('docs'), item('acme/app'), item('settings', vi.fn(), { kind: 'Action' })], onClose);
    palette.open();
    type('app');
    expect(labels()).toEqual(['acme/app']);
    type('action');
    expect(labels()).toEqual(['settings']);
  });

  it('says so when nothing matches, and does not run anything on Enter', () => {
    const run = vi.fn();
    createPalette(() => [item('docs', run)], onClose).open();
    type('zzzzz');
    expect(rows().map((row) => row.textContent)).toEqual(['Nothing matches']);
    press('Enter');
    expect(run).not.toHaveBeenCalled();
  });

  it('shows at most sixty results', () => {
    createPalette(() => Array.from({ length: 100 }, (_, index) => item(`workspace ${index}`)), onClose).open();
    expect(rows()).toHaveLength(60);
  });
});

describe('keyboard', () => {
  const open = (...names: string[]) => {
    const runs = names.map(() => vi.fn());
    const palette = createPalette(() => names.map((name, index) => item(name, runs[index])), onClose);
    palette.open();
    return { palette, runs };
  };

  it('moves the highlight with the arrows or Ctrl+N and Ctrl+P, stopping at the ends', () => {
    open('a', 'b', 'c');
    press('ArrowDown');
    expect(activeLabel()).toBe('b');
    press('n', { ctrlKey: true });
    expect(activeLabel()).toBe('c');
    press('ArrowDown');
    expect(activeLabel()).toBe('c');
    press('ArrowUp');
    press('p', { ctrlKey: true });
    press('ArrowUp');
    expect(activeLabel()).toBe('a');
    expect(scrolled()).toBe(true);
  });

  it('runs the highlighted item on Enter, after closing', () => {
    const { palette, runs } = open('a', 'b');
    press('ArrowDown');
    press('Enter');
    expect(runs[1]).toHaveBeenCalledTimes(1);
    expect(runs[0]).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(root().hidden).toBe(true);
  });

  it('closes on Escape, and keeps the keys it handled from reaching the page', () => {
    const { palette } = open('a');
    const stop = vi.fn();
    document.addEventListener('keydown', stop);
    const escape = press('Escape');
    expect(palette.isOpen).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    document.removeEventListener('keydown', stop);
  });

  it('leaves other keys alone so typing works', () => {
    open('a');
    expect(press('x').defaultPrevented).toBe(false);
  });

  it('puts the highlight back at the top when the search changes', () => {
    open('ab', 'ac', 'ad');
    press('ArrowDown');
    type('a');
    expect(activeLabel()).toBe('ab');
  });
});

describe('mouse', () => {
  it('highlights the row under the pointer and runs the one clicked', () => {
    const run = vi.fn();
    const palette = createPalette(() => [item('a'), item('b', run)], onClose);
    palette.open();
    rows()[1]!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(activeLabel()).toBe('b');
    rows()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(palette.isOpen).toBe(false);
  });

  it('closes when the dimmed area is pressed, but not the box', () => {
    const palette = createPalette(() => [item('a')], onClose);
    palette.open();
    input().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(palette.isOpen).toBe(true);
    root().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(palette.isOpen).toBe(false);
  });

  it('does not call onClose for a close while already closed', () => {
    const palette = createPalette(() => [], onClose);
    palette.close();
    expect(onClose).not.toHaveBeenCalled();
  });
});

function scrolled(): boolean {
  return (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length > 0;
}
