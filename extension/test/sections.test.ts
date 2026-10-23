// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSectionsResizable } from '../src/sections';
import { installChrome } from './chrome-mock';

let fake: ReturnType<typeof installChrome>;
const fit = vi.fn();

/** Reports a height for an element, which happy-dom does not lay out. */
const sized = (id: string, height: number) => {
  const node = document.getElementById(id)!;
  node.getBoundingClientRect = () => ({ height }) as DOMRect;
  return node;
};

beforeEach(() => {
  fake = installChrome();
  fit.mockClear();
  document.body.innerHTML = `
    <div id="list"></div>
    <section id="git"><div class="v-resizer" data-resize="git"></div></section>
    <section id="reviews"><div class="v-resizer" data-resize="reviews"></div></section>
    <section id="activity"><div class="v-resizer" data-resize="activity"></div></section>`;
  sized('list', 600);
  sized('git', 200);
  sized('reviews', 100);
  sized('activity', 50);
  // Pointer capture is a browser feature; track it per handle.
  for (const handle of document.querySelectorAll<HTMLElement>('.v-resizer')) {
    let captured = false;
    handle.setPointerCapture = () => void (captured = true);
    handle.releasePointerCapture = () => void (captured = false);
    handle.hasPointerCapture = () => captured;
  }
});
afterEach(() => vi.unstubAllGlobals());

const pointer = (target: Element, type: string, clientY = 0) => {
  const event = new Event(type, { bubbles: true }) as Event & { pointerId: number; clientY: number };
  event.pointerId = 1;
  event.clientY = clientY;
  target.dispatchEvent(event);
};
const handle = (section: string) => document.querySelector(`.v-resizer[data-resize="${section}"]`)!;
const height = (section: string) => document.getElementById(section)!.style.height;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('restoring', () => {
  it('applies the heights saved earlier, ignoring anything that is not a number', async () => {
    fake.storage.local.sectionHeights = { git: 250, reviews: 'tall' };
    makeSectionsResizable(fit);
    await flush();
    expect(height('git')).toBe('250px');
    expect(document.getElementById('git')!.style.maxHeight).toBe('none');
    expect(height('reviews')).toBe('');
  });

  it('leaves sections at their natural height when nothing was saved', async () => {
    makeSectionsResizable(fit);
    await flush();
    expect([height('git'), height('reviews')]).toEqual(['', '']);
  });
});

describe('dragging', () => {
  beforeEach(() => makeSectionsResizable(fit));

  it('makes the section taller as the edge is dragged up, and shorter as it is dragged down', () => {
    pointer(handle('git'), 'pointerdown', 500);
    pointer(handle('git'), 'pointermove', 450);
    expect(height('git')).toBe('250px');
    pointer(handle('git'), 'pointermove', 530);
    expect(height('git')).toBe('170px');
  });

  it('keeps a section at least 80px tall', () => {
    pointer(handle('git'), 'pointerdown', 500);
    pointer(handle('git'), 'pointermove', 900);
    expect(height('git')).toBe('80px');
  });

  it('leaves the workspace list 120px, and the other sections their height', () => {
    pointer(handle('git'), 'pointerdown', 500);
    pointer(handle('git'), 'pointermove', -5000);
    // 600 list - 120 minimum - 100 for the reviews section - 50 for activity.
    expect(height('git')).toBe('330px');
    pointer(handle('activity'), 'pointerdown', 500);
    pointer(handle('activity'), 'pointermove', -5000);
    // 600 list - 120 minimum - 200 for git - 100 for reviews.
    expect(height('activity')).toBe('180px');
  });

  it('ignores moves when no drag is in progress', () => {
    pointer(handle('git'), 'pointermove', 100);
    expect(height('git')).toBe('');
  });

  it('saves the heights and refits the terminal when the drag ends', async () => {
    pointer(handle('reviews'), 'pointerdown', 500);
    pointer(handle('reviews'), 'pointermove', 480);
    pointer(handle('reviews'), 'pointerup', 480);
    expect(fake.storage.local.sectionHeights).toEqual({ reviews: 120 });
    expect(fit).toHaveBeenCalledTimes(1);
    expect(handle('reviews').classList.contains('dragging')).toBe(false);

    // The capture is released, so further moves do nothing.
    pointer(handle('reviews'), 'pointermove', 100);
    expect(height('reviews')).toBe('120px');
  });

  it('also finishes when the pointer is cancelled', () => {
    pointer(handle('git'), 'pointerdown', 500);
    pointer(handle('git'), 'pointercancel', 500);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('marks the handle while it is dragged', () => {
    pointer(handle('git'), 'pointerdown', 500);
    expect(handle('git').classList.contains('dragging')).toBe(true);
  });

  it('returns a section to its natural height on double-click, and saves that', () => {
    pointer(handle('git'), 'pointerdown', 500);
    pointer(handle('git'), 'pointermove', 450);
    pointer(handle('git'), 'pointerup', 450);
    handle('git').dispatchEvent(new Event('dblclick', { bubbles: true }));
    expect(height('git')).toBe('');
    expect(document.getElementById('git')!.style.maxHeight).toBe('');
    expect(fake.storage.local.sectionHeights).toEqual({});
  });
});
