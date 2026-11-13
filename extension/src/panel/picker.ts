import type { ControlToHelper } from '../../../shared/protocol/protocol';
import { similarity } from '../../../shared/workspaces/pairing';
import { $ } from '../ui/dom';
import type { PanelState } from './state';

export interface PickerOptions {
  state: Pick<PanelState, 'windowId' | 'workspaces'>;
  send: (message: ControlToHelper) => void;
}

/** What a window with no workspace shows: the workspaces to pair with, closest match first, and a box to create one. */
export interface Picker {
  render(): Promise<void>;
}

export function createPicker({ state, send }: PickerOptions): Picker {
  const options = $<HTMLUListElement>('picker-options');
  const form = $<HTMLFormElement>('picker-new');
  const name = $<HTMLInputElement>('picker-name');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = name.value.trim();
    if (text && state.windowId !== undefined) send({ type: 'create', name: text, windowId: state.windowId });
    name.value = '';
  });

  async function render(): Promise<void> {
    const { windowId } = state;
    if (windowId === undefined) return;
    const tabs = await chrome.tabs.query({ windowId });
    const urls = tabs.flatMap((tab) => (tab.url ? [tab.url] : []));
    const ranked = [...state.workspaces].sort(
      (a, b) => similarity(b.lastTabUrls, urls) - similarity(a.lastTabUrls, urls) || Number(a.windowId !== null) - Number(b.windowId !== null),
    );

    options.replaceChildren(
      ...ranked.map((ws) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.textContent = ws.name;
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = ws.windowId === null ? 'no window' : 'moves here from its window';
        button.append(hint);
        button.addEventListener('click', () => state.windowId !== undefined && send({ type: 'pair', id: ws.id, windowId: state.windowId }));
        item.append(button);
        return item;
      }),
    );
  }

  return { render };
}
