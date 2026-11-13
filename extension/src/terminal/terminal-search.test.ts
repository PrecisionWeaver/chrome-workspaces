// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { loadPanelHtml } from '../../testing/fixtures';
import { createTerminalSearch, type Searcher, type TerminalSearch } from './terminal-search';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Records what the box asks of xterm's search addon. */
let calls: string[];
const searcher: Searcher = {
  findNext: vi.fn((term: string, options?: { incremental?: boolean }) => (calls.push(`next:${term}:${options?.incremental}`), true)),
  findPrevious: vi.fn((term: string, options?: { incremental?: boolean }) => (calls.push(`prev:${term}:${options?.incremental}`), true)),
  clearDecorations: vi.fn(() => void calls.push('clear')),
};
let focusTerminal: Mock<() => void>;
let search: TerminalSearch;

const input = () => $<HTMLInputElement>('term-search-input');
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event('input'));
};
const key = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(event);
  return event;
};

beforeEach(() => {
  loadPanelHtml();
  calls = [];
  focusTerminal = vi.fn();
  search = createTerminalSearch(searcher, focusTerminal);
});

describe('opening and closing', () => {
  it('starts closed, opens with the box focused and its text selected, and says so', () => {
    expect(search.isOpen).toBe(false);
    expect($('term-search').hidden).toBe(true);
    input().value = 'old';
    const select = vi.spyOn(input(), 'select');
    search.open();
    expect(search.isOpen).toBe(true);
    expect($('term-search').hidden).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(select).toHaveBeenCalled();
  });

  it('closes on Escape, clearing the highlights and handing focus back to the terminal', () => {
    search.open();
    expect(key('Escape').defaultPrevented).toBe(true);
    expect(search.isOpen).toBe(false);
    expect(calls).toEqual(['clear']);
    expect(focusTerminal).toHaveBeenCalledTimes(1);
  });

  it('closes from its button', () => {
    search.open();
    $('term-search-close').click();
    expect(search.isOpen).toBe(false);
    expect(focusTerminal).toHaveBeenCalledTimes(1);
  });

  it('does nothing when closed again, so the terminal is not refocused for no reason', () => {
    search.close();
    expect(calls).toEqual([]);
    expect(focusTerminal).not.toHaveBeenCalled();
  });
});

describe('finding', () => {
  beforeEach(() => search.open());

  it('finds as you type, and clears the highlights when the box is emptied', () => {
    type('err');
    type('erro');
    type('');
    expect(calls).toEqual(['next:err:true', 'next:erro:true', 'clear']);
  });

  it('steps to the next match on Enter and the previous on Shift+Enter, without moving the view for typing', () => {
    type('error');
    calls = [];
    expect(key('Enter').defaultPrevented).toBe(true);
    key('Enter', { shiftKey: true });
    expect(calls).toEqual(['next:error:false', 'prev:error:false']);
  });

  it('ignores Enter with nothing to find', () => {
    key('Enter');
    key('Enter', { shiftKey: true });
    expect(calls).toEqual([]);
  });

  it('steps from the arrows too, only once there is something to find', () => {
    $('term-search-next').click();
    $('term-search-prev').click();
    expect(calls).toEqual([]);
    type('error');
    calls = [];
    $('term-search-next').click();
    $('term-search-prev').click();
    expect(calls).toEqual(['next:error:false', 'prev:error:false']);
  });

  it('leaves other keys to the box', () => {
    expect(key('a').defaultPrevented).toBe(false);
    expect(search.isOpen).toBe(true);
  });
});
