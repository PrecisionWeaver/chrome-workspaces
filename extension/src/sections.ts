const MIN_HEIGHT = 80;
// Room kept for the workspace list above the sections.
const MIN_LIST_HEIGHT = 120;

type Section = 'git' | 'reviews';

/** Lets the Source control and Review requests sections be dragged taller or shorter by their top edge. */
export function makeSectionsResizable(fitTerminal: () => void): void {
  const heights: Partial<Record<Section, number>> = {};

  const apply = (section: Section, height: number | undefined): void => {
    const node = document.getElementById(section) as HTMLElement;
    node.style.height = height === undefined ? '' : `${height}px`;
    node.style.maxHeight = height === undefined ? '' : 'none';
  };

  void chrome.storage.local.get('sectionHeights').then(({ sectionHeights }) => {
    for (const section of ['git', 'reviews'] as const) {
      const height = (sectionHeights as Partial<Record<Section, number>> | undefined)?.[section];
      if (typeof height === 'number') apply(section, (heights[section] = height));
    }
  });

  for (const handle of document.querySelectorAll<HTMLElement>('.v-resizer')) {
    const section = handle.dataset.resize as Section;
    const node = document.getElementById(section) as HTMLElement;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener('pointerdown', (event) => {
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      startY = event.clientY;
      startHeight = node.getBoundingClientRect().height;
    });
    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      // The other section keeps its height; the workspace list gives way first.
      const list = document.getElementById('list') as HTMLElement;
      const other = document.getElementById(section === 'git' ? 'reviews' : 'git') as HTMLElement;
      const room = list.getBoundingClientRect().height - MIN_LIST_HEIGHT - other.getBoundingClientRect().height;
      const next = Math.round(Math.min(Math.max(startHeight + (startY - event.clientY), MIN_HEIGHT), Math.max(room, MIN_HEIGHT)));
      heights[section] = next;
      apply(section, next);
    });
    const finish = (event: PointerEvent): void => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      handle.releasePointerCapture(event.pointerId);
      handle.classList.remove('dragging');
      void chrome.storage.local.set({ sectionHeights: { ...heights } });
      fitTerminal();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    // Double-clicking the edge returns the section to its natural height.
    handle.addEventListener('dblclick', () => {
      delete heights[section];
      apply(section, undefined);
      void chrome.storage.local.set({ sectionHeights: { ...heights } });
    });
  }
}
