import type { AdminAction, ControlToHelper } from '../../../shared/protocol/protocol';
import { type Arming, el } from '../ui/dom';

/** Small builders shared by the Settings cards. */

export const row = (label: string, value: string | Node, title = ''): HTMLElement => {
  const line = el('div', '', 'kv');
  line.title = title;
  line.append(el('span', label, 'k'));
  const v = el('span', '', 'v');
  v.append(value);
  line.append(v);
  return line;
};

export const card = (title: string, ...children: Node[]): HTMLElement => {
  const node = el('section', '', 'settings-card');
  // Matches a card across renders; the count after a "·" changes from poll to poll.
  node.dataset.key = title.split(' · ')[0];
  node.append(el('h3', title), ...children);
  return node;
};

export const actions = (...buttons: Node[]): HTMLElement => {
  const node = el('div', '', 'settings-actions');
  node.append(...buttons);
  return node;
};

export const mono = (text: string): HTMLElement => el('span', text, 'mono');

/** What every card can do: talk to the helper, redraw the view, and report an outcome. */
export interface SettingsContext {
  send(message: ControlToHelper): boolean;
  request(action: AdminAction): void;
  render(): void;
  showResult(result: { ok: boolean; message: string }): void;
  arming: Arming;
}

/** A button that asks again before doing something destructive. */
export function guarded(
  ctx: SettingsContext,
  key: string,
  label: string,
  confirmLabel: string,
  run: () => void,
  options: { danger?: boolean; disabled?: string } = {},
): HTMLButtonElement {
  const isArmed = ctx.arming.isArmed(key);
  const button = el('button', isArmed ? confirmLabel : label, `settings-btn${options.danger ? ' danger' : ''}${isArmed ? ' armed' : ''}`);
  button.type = 'button';
  if (options.disabled) {
    button.disabled = true;
    button.title = options.disabled;
  }
  button.addEventListener('click', () => {
    if (ctx.arming.click(key)) run();
    ctx.render();
  });
  return button;
}

export function plain(label: string, run: () => void, title = ''): HTMLButtonElement {
  const button = el('button', label, 'settings-btn');
  button.type = 'button';
  button.title = title;
  button.addEventListener('click', run);
  return button;
}

/** A session's claude id, cut to its first group, e.g. `0b7c1b4a`. */
export const shortId = (id: string): string => id.split('-')[0];
