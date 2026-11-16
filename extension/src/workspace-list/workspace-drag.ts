import type { Workspace } from '../../../shared/protocol/protocol';

export interface WorkspaceDragOptions {
  /** The list as it is now, to find where a drop lands. */
  workspaces(): Workspace[];
  /** Shows the new order at once, so the list does not jump back while the helper's state is on its way. */
  reorder(next: Workspace[]): void;
  /** Tells the helper where a workspace now sits. */
  move(id: string, index: number): void;
  /** The drag is over, dropped or cancelled: the list may be drawn again. */
  onEnd(): void;
}

export interface WorkspaceDrag {
  /** Makes a row draggable, and a place to drop. */
  attach(item: HTMLLIElement, ws: Workspace): void;
  /** Whether a workspace is being dragged; the list is not redrawn meanwhile. */
  readonly active: boolean;
}

/** Drag to reorder: a row is dragged, and dropped before or after another by which half it is over. */
export function createWorkspaceDrag({ workspaces, reorder, move, onEnd }: WorkspaceDragOptions): WorkspaceDrag {
  let dragged: Workspace | null = null;

  return {
    get active() {
      return dragged !== null;
    },
    attach(item, ws) {
      item.draggable = true;
      item.addEventListener('dragstart', (event) => {
        dragged = ws;
        item.classList.add('dragging');
        event.dataTransfer?.setData('text/plain', ws.name);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragover', (event) => {
        if (!dragged) return;
        event.preventDefault();
        const { top, height } = item.getBoundingClientRect();
        const after = event.clientY > top + height / 2;
        item.classList.toggle('drop-before', !after);
        item.classList.toggle('drop-after', after);
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        const moving = dragged;
        const after = item.classList.contains('drop-after');
        if (!moving || moving.id === ws.id) return;
        const rest = workspaces().filter((w) => w.id !== moving.id);
        const index = rest.findIndex((w) => w.id === ws.id) + (after ? 1 : 0);
        reorder([...rest.slice(0, index), moving, ...rest.slice(index)]);
        move(moving.id, index);
      });
      // Fires after drop, or alone when the drag is cancelled.
      item.addEventListener('dragend', () => {
        dragged = null;
        onEnd();
      });
    },
  };
}
