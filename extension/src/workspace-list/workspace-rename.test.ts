// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWorkspace } from '../../testing/fixtures';
import { startRename } from './workspace-rename';

const ws = makeWorkspace({ id: 'ws-a', name: 'acme/app' });
let nameEl: HTMLSpanElement;
let renames: string[];
let done: number;

beforeEach(() => {
  document.body.replaceChildren();
  nameEl = document.createElement('span');
  nameEl.textContent = ws.name;
  document.body.append(nameEl);
  renames = [];
  done = 0;
  startRename(
    ws,
    nameEl,
    (name) => renames.push(name),
    () => void done++,
  );
});

const input = () => document.querySelector<HTMLInputElement>('input.rename')!;
const key = (name: string) => input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

describe('startRename', () => {
  it('replaces the name with a focused box holding it, limited to 80 characters', () => {
    expect(nameEl.isConnected).toBe(false);
    expect(input().value).toBe('acme/app');
    expect(input().maxLength).toBe(80);
    expect(document.activeElement).toBe(input());
  });

  it('saves a trimmed new name on Enter, once', () => {
    input().value = '  acme/api  ';
    key('Enter');
    input().dispatchEvent(new Event('blur'));
    expect(renames).toEqual(['acme/api']);
    expect(done).toBe(1);
  });

  it('saves on leaving the box', () => {
    input().value = 'acme/api';
    input().dispatchEvent(new Event('blur'));
    expect(renames).toEqual(['acme/api']);
  });

  it('discards on Escape, even after the name was changed, and does not save on the blur that follows', () => {
    input().value = 'acme/api';
    key('Escape');
    input().dispatchEvent(new Event('blur'));
    expect(renames).toEqual([]);
    expect(done).toBe(1);
  });

  it('sends nothing for a blank or unchanged name, but still finishes', () => {
    input().value = '   ';
    key('Enter');
    expect(renames).toEqual([]);
    expect(done).toBe(1);
  });

  it('keeps typing and clicks in the box from reaching the list', () => {
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    document.body.addEventListener('click', outer);
    key('a');
    input().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(outer).not.toHaveBeenCalled();
  });
});
