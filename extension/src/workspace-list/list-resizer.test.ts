// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { installChrome } from '../../testing/chrome-mock';
import { loadPanelHtml } from '../../testing/fixtures';
import { createListResizer } from './list-resizer';

let fake: ReturnType<typeof installChrome>;
let handle: HTMLElement;
let captured: number | null;
let onResized: Mock<() => void>;

const width = () => document.body.style.getPropertyValue('--list-width');
/** happy-dom has no pointer events; the handle gets just enough of the capture API for the resizer to drive. */
const pointer = (type: string, clientX: number) => {
  const event = new Event(type, { bubbles: true }) as Event & { pointerId: number; clientX: number };
  event.pointerId = 1;
  event.clientX = clientX;
  handle.dispatchEvent(event);
};

beforeEach(() => {
  fake = installChrome();
  loadPanelHtml();
  handle = document.getElementById('list-resizer')!;
  captured = null;
  handle.setPointerCapture = (id: number) => void (captured = id);
  handle.releasePointerCapture = () => void (captured = null);
  handle.hasPointerCapture = (id: number) => captured === id;
  onResized = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe('setWidth', () => {
  it('sets the list’s width on the page, rounded and kept within its limits', () => {
    const resizer = createListResizer(handle, onResized);
    expect(resizer.setWidth(300.4)).toBe(300);
    expect(width()).toBe('300px');
    expect(resizer.setWidth(10)).toBe(140);
    expect(width()).toBe('140px');
    expect(resizer.setWidth(9999)).toBe(520);
    expect(width()).toBe('520px');
  });
});

describe('dragging the handle', () => {
  it('follows the pointer only while it is held down, and marks the handle', () => {
    createListResizer(handle, onResized);
    pointer('pointermove', 300);
    expect(width()).toBe('');
    pointer('pointerdown', 0);
    expect(handle.classList.contains('dragging')).toBe(true);
    pointer('pointermove', 300);
    expect(width()).toBe('300px');
    pointer('pointermove', 320);
    expect(width()).toBe('320px');
  });

  it('remembers the width where the pointer is let go, within limits, and tells the terminal to refit', async () => {
    createListResizer(handle, onResized);
    pointer('pointerdown', 0);
    pointer('pointermove', 300);
    pointer('pointerup', 900);
    expect(handle.classList.contains('dragging')).toBe(false);
    expect(captured).toBeNull();
    expect(width()).toBe('520px');
    await vi.waitFor(() => expect(fake.storage.local.listWidth).toBe(520));
    expect(onResized).toHaveBeenCalledTimes(1);
    // The pointer is no longer held, so moving it changes nothing.
    pointer('pointermove', 200);
    expect(width()).toBe('520px');
  });
});
