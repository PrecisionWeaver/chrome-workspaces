// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../../shared/protocol/workspace';
import { makeWorkspace } from '../../testing/fixtures';
import { createWorkspaceDrag, type WorkspaceDrag } from './workspace-drag';

const [a, b, c] = ['ws-a', 'ws-b', 'ws-c'].map((id) => makeWorkspace({ id, name: id }));
let rows: Map<string, HTMLLIElement>;
let drag: WorkspaceDrag;
let reordered: Workspace[][];
let moves: [string, number][];
let ended: number;

/** A drag event carrying a pointer height, since happy-dom has no DragEvent. */
function dragEvent(type: string, clientY = 0): Event & { clientY: number; dataTransfer: { setData: ReturnType<typeof vi.fn>; effectAllowed: string } } {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    clientY: number;
    dataTransfer: { setData: ReturnType<typeof vi.fn>; effectAllowed: string };
  };
  event.clientY = clientY;
  event.dataTransfer = { setData: vi.fn(), effectAllowed: '' };
  return event;
}

beforeEach(() => {
  reordered = [];
  moves = [];
  ended = 0;
  drag = createWorkspaceDrag({
    workspaces: () => [a!, b!, c!],
    reorder: (next) => reordered.push(next),
    move: (id, index) => moves.push([id, index]),
    onEnd: () => void ended++,
  });
  rows = new Map();
  for (const ws of [a!, b!, c!]) {
    const row = document.createElement('li');
    // Each row is 100px tall, so a pointer above 50 is over its top half.
    row.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect;
    drag.attach(row, ws);
    rows.set(ws.id, row);
  }
});

const row = (id: string) => rows.get(id)!;

describe('dragging', () => {
  it('makes rows draggable, and marks the one being dragged', () => {
    expect(row('ws-a').draggable).toBe(true);
    const start = dragEvent('dragstart');
    row('ws-a').dispatchEvent(start);
    expect(row('ws-a').classList.contains('dragging')).toBe(true);
    expect(start.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'ws-a');
    expect(start.dataTransfer.effectAllowed).toBe('move');
    expect(drag.active).toBe(true);
  });

  it('marks the half of a row the pointer is over, and clears it when the pointer leaves', () => {
    row('ws-a').dispatchEvent(dragEvent('dragstart'));
    const over = dragEvent('dragover', 20);
    row('ws-b').dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(row('ws-b').classList.contains('drop-before')).toBe(true);
    row('ws-b').dispatchEvent(dragEvent('dragover', 80));
    expect([row('ws-b').classList.contains('drop-before'), row('ws-b').classList.contains('drop-after')]).toEqual([false, true]);
    row('ws-b').dispatchEvent(dragEvent('dragleave'));
    expect(row('ws-b').className).toBe('');
  });

  it('ignores a drag over a row when nothing in the list is being dragged', () => {
    const over = dragEvent('dragover', 20);
    row('ws-b').dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    expect(row('ws-b').className).toBe('');
  });
});

describe('dropping', () => {
  const dropOn = (from: string, onto: string, clientY: number) => {
    row(from).dispatchEvent(dragEvent('dragstart'));
    row(onto).dispatchEvent(dragEvent('dragover', clientY));
    row(onto).dispatchEvent(dragEvent('drop', clientY));
  };

  it('puts the workspace before a row dropped on its top half', () => {
    dropOn('ws-c', 'ws-a', 20);
    expect(reordered[0]!.map((w) => w.id)).toEqual(['ws-c', 'ws-a', 'ws-b']);
    expect(moves).toEqual([['ws-c', 0]]);
  });

  it('puts it after a row dropped on its bottom half', () => {
    dropOn('ws-a', 'ws-b', 80);
    expect(reordered[0]!.map((w) => w.id)).toEqual(['ws-b', 'ws-a', 'ws-c']);
    expect(moves).toEqual([['ws-a', 1]]);
  });

  it('does nothing when a workspace is dropped on itself', () => {
    dropOn('ws-b', 'ws-b', 20);
    expect(reordered).toEqual([]);
    expect(moves).toEqual([]);
  });

  it('is over when the drag ends, dropped or cancelled, and says so once', () => {
    row('ws-a').dispatchEvent(dragEvent('dragstart'));
    row('ws-a').dispatchEvent(dragEvent('dragend'));
    expect(drag.active).toBe(false);
    expect(ended).toBe(1);
  });
});
