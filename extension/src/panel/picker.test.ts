// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToHelper } from '../../../shared/protocol/protocol';
import { installChrome } from '../../testing/chrome-mock';
import { loadPanelHtml, makeWorkspace } from '../../testing/fixtures';
import { createPicker, type Picker } from './picker';
import { createPanelState, type PanelState } from './state';

let fake: ReturnType<typeof installChrome>;
let state: PanelState;
let picker: Picker;
let windowId: number;
const send = vi.fn((_message: ControlToHelper) => true);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ws = (id: string, overrides = {}) => makeWorkspace({ id, name: `acme/${id}`, windowId, ...overrides });
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('#picker-options button')];

beforeEach(() => {
  fake = installChrome();
  windowId = fake.addWindow('https://example.com/start').windowId;
  loadPanelHtml();
  send.mockClear();
  state = createPanelState();
  state.windowId = windowId;
  picker = createPicker({ state, send });
});

describe('pairing', () => {
  it('offers the workspaces, the closest match to this window’s tabs first, and pairs the one chosen', async () => {
    state.workspaces = [
      ws('far', { windowId: null, lastTabUrls: ['https://other.example/'] }),
      ws('near', { windowId: null, lastTabUrls: ['https://example.com/start'] }),
    ];
    await picker.render();
    expect(buttons().map((b) => b.firstChild!.textContent)).toEqual(['acme/near', 'acme/far']);
    expect(buttons()[0]!.querySelector('.hint')!.textContent).toBe('no window');
    buttons()[0]!.click();
    expect(send).toHaveBeenCalledWith({ type: 'pair', id: 'near', windowId });
  });

  it('lists one without a window before one that would have to move, all else equal', async () => {
    const { windowId: other } = fake.addWindow();
    state.workspaces = [ws('elsewhere', { windowId: other }), ws('free', { windowId: null })];
    await picker.render();
    expect(buttons().map((b) => b.firstChild!.textContent)).toEqual(['acme/free', 'acme/elsewhere']);
    expect(buttons()[1]!.querySelector('.hint')!.textContent).toBe('moves here from its window');
  });

  it('draws nothing while the window is unknown', async () => {
    state.windowId = undefined;
    state.workspaces = [ws('a', { windowId: null })];
    await picker.render();
    expect(buttons()).toEqual([]);
  });
});

describe('the name box', () => {
  it('creates a workspace in this window from the name, trimmed, and clears the box', () => {
    $<HTMLInputElement>('picker-name').value = '  new thing ';
    $('picker-new').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(send).toHaveBeenCalledWith({ type: 'create', name: 'new thing', windowId });
    expect($<HTMLInputElement>('picker-name').value).toBe('');
  });

  it('creates nothing without a name, or while the window is unknown', () => {
    $('picker-new').dispatchEvent(new Event('submit', { cancelable: true }));
    state.windowId = undefined;
    $<HTMLInputElement>('picker-name').value = 'thing';
    $('picker-new').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(send).not.toHaveBeenCalled();
  });
});
