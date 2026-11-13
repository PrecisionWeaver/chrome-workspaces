const MIN_LIST_WIDTH = 140;
const MAX_LIST_WIDTH = 520;

export interface ListResizer {
  /** Sets the list's width, kept within its limits, and returns the width used. */
  setWidth(width: number): number;
}

/** The drag handle between the workspace list and the terminal. The width is remembered across sessions. */
export function createListResizer(handle: HTMLElement, onResized: () => void): ListResizer {
  const setWidth = (width: number): number => {
    const clamped = Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.round(width)));
    document.body.style.setProperty('--list-width', `${clamped}px`);
    return clamped;
  };

  handle.addEventListener('pointerdown', (event) => {
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
  });

  handle.addEventListener('pointermove', (event) => {
    if (handle.hasPointerCapture(event.pointerId)) setWidth(event.clientX);
  });

  handle.addEventListener('pointerup', (event) => {
    handle.releasePointerCapture(event.pointerId);
    handle.classList.remove('dragging');
    void chrome.storage.local.set({ listWidth: setWidth(event.clientX) });
    onResized();
  });

  return { setWidth };
}
