// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../../shared/protocol';
import { attachFileDrop } from '../src/file-drop';

let target: HTMLElement;
let send: ReturnType<typeof vi.fn<(name: string, base64: string) => boolean>>;
let notice: ReturnType<typeof vi.fn<(text: string | null) => void>>;

beforeEach(() => {
  document.body.innerHTML = '<div id="term"><span id="inner"></span></div>';
  target = document.getElementById('term')!;
  send = vi.fn(() => true);
  notice = vi.fn();
  attachFileDrop(target, { send, notice });
});
afterEach(() => vi.useRealTimers());

const file = (name: string, content = 'hello') => new File([content], name);
/** Reading a file takes a few real ticks, so this waits on the clock rather than faking it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A drag or drop event; happy-dom has no DragEvent, so the parts the code reads are attached. */
function dragEvent(type: string, data: { types?: string[]; files?: File[]; relatedTarget?: Node | null } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
  event.dataTransfer = { types: data.types ?? ['Files'], files: data.files ?? [], dropEffect: 'none' };
  event.relatedTarget = data.relatedTarget ?? null;
  target.dispatchEvent(event);
  return event as unknown as Event & { dataTransfer: { dropEffect: string } };
}

function paste(files: File[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
  event.clipboardData = { files };
  const reached = vi.fn();
  document.addEventListener('paste', reached, { once: true });
  target.querySelector('#inner')!.dispatchEvent(event);
  return { event, reached };
}

describe('dropping files', () => {
  it('sends each file as base64 under its own name', async () => {
    dragEvent('drop', { files: [file('a.txt', 'hello'), file('b.png', 'world')] });
    await settle();
    expect(send.mock.calls).toEqual([
      ['a.txt', btoa('hello')],
      ['b.png', btoa('world')],
    ]);
    expect(notice).not.toHaveBeenCalled();
  });

  it('marks the terminal as a drop target while a file is over it, and unmarks it on leave or drop', () => {
    const over = dragEvent('dragover');
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    expect(target.classList.contains('drop-target')).toBe(true);

    dragEvent('dragleave', { relatedTarget: document.body });
    expect(target.classList.contains('drop-target')).toBe(false);

    dragEvent('dragover');
    dragEvent('drop', { files: [] });
    expect(target.classList.contains('drop-target')).toBe(false);
  });

  it('stays marked while the pointer moves between the terminal and its children', () => {
    dragEvent('dragover');
    dragEvent('dragleave', { relatedTarget: target.querySelector('#inner') });
    expect(target.classList.contains('drop-target')).toBe(true);
  });

  it('ignores drags that carry text or a link rather than files', async () => {
    const over = dragEvent('dragover', { types: ['text/plain'] });
    const drop = dragEvent('drop', { types: ['text/plain'], files: [file('a.txt')] });
    await settle();
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(target.classList.contains('drop-target')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('names a nameless file "file"', async () => {
    dragEvent('drop', { files: [file('')] });
    await settle();
    expect(send.mock.calls[0]![0]).toBe('file');
  });
});

describe('pasting', () => {
  it("sends a pasted image and keeps it from the terminal's own paste", async () => {
    const { event, reached } = paste([file('image.png', 'png')]);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('image.png', btoa('png'));
  });

  it('leaves plain text paste to the terminal', async () => {
    const { event, reached } = paste([]);
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(reached).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('problems', () => {
  it('refuses a file over the limit, and carries on with the others', async () => {
    const big = file('big.bin');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    dragEvent('drop', { files: [big, file('ok.txt')] });
    await settle();
    expect(notice).toHaveBeenCalledWith(`big.bin is over ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB, so it was not added.`);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('ok.txt', expect.any(String));
  });

  it('says so when the terminal is not connected', async () => {
    send.mockReturnValue(false);
    dragEvent('drop', { files: [file('a.txt')] });
    await settle();
    expect(notice).toHaveBeenCalledWith('Not connected to the terminal, so the file was not added.');
  });

  it('says so when a file cannot be read', async () => {
    const unreadable = file('gone.txt');
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      queueMicrotask(() => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>));
    });
    dragEvent('drop', { files: [unreadable] });
    await settle();
    expect(notice).toHaveBeenCalledWith('Could not read gone.txt.');
    vi.restoreAllMocks();
  });

  it('clears the message after five seconds, restarting the wait for each new one', async () => {
    send.mockReturnValue(false);
    // happy-dom's reader runs on timers, so a plain one stands in to let the clock be faked.
    class InstantReader {
      result = 'data:;base64,eA==';
      onload: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('FileReader', InstantReader);
    vi.useFakeTimers();

    dragEvent('drop', { files: [file('a.txt')] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(notice).toHaveBeenCalledTimes(1);
    dragEvent('drop', { files: [file('b.txt')] });
    await vi.advanceTimersByTimeAsync(4999);
    expect(notice).not.toHaveBeenCalledWith(null);
    await vi.advanceTimersByTimeAsync(1);
    expect(notice).toHaveBeenLastCalledWith(null);
    expect(notice.mock.calls.filter(([text]) => text === null)).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
