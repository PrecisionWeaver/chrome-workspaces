// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Prompt } from '../../../shared/protocol/workspace';
import { createPromptPicker } from './prompt-picker';

const prompt = (section: string, text: string): Prompt => ({ section, text });

let container: HTMLDivElement;
let filter: HTMLInputElement;
let chosen: Prompt[];
let picker: ReturnType<typeof createPromptPicker>;

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement('div');
  filter = document.createElement('input');
  document.body.append(container, filter);
  chosen = [];
  picker = createPromptPicker({ container, filter, onChoose: (p) => chosen.push(p) });
});

const type = (text: string) => {
  filter.value = text;
  filter.dispatchEvent(new Event('input'));
};
const cards = () => [...container.querySelectorAll('.prompt')].map((node) => node.textContent);
const tabs = () => [...container.querySelectorAll('.prompt-tabs button')].map((node) => node.textContent);

describe('with one section', () => {
  it('lists its prompts under one heading, with no tabs', () => {
    picker.set([prompt('', 'one'), prompt('', 'two')]);
    expect(container.querySelector('.prompt-tabs')).toBeNull();
    expect(container.querySelector('.prompt-group h3')!.textContent).toBe('Prompts2');
    expect(cards()).toEqual(['one', 'two']);
  });

  it('chooses the one clicked', () => {
    const [first] = [prompt('', 'one')];
    picker.set([first!, prompt('', 'two')]);
    (container.querySelector('.prompt') as HTMLButtonElement).click();
    expect(chosen).toEqual([first]);
  });

  it('draws nothing for no prompts', () => {
    picker.set([]);
    expect(container.children).toHaveLength(0);
  });
});

describe('with several sections', () => {
  const all = [prompt('Fix', 'a'), prompt('Fix', 'b'), prompt('Review', 'c')];

  it('shows a tab for each, with its count, and the first one is open', () => {
    picker.set(all);
    expect(tabs()).toEqual(['Fix2', 'Review1']);
    expect(container.querySelector('.prompt-tabs .active')!.textContent).toBe('Fix2');
    expect(cards()).toEqual(['a', 'b']);
  });

  it('opens another when its tab is clicked, and keeps it when the prompts are set again', () => {
    picker.set(all);
    (container.querySelectorAll('.prompt-tabs button')[1] as HTMLButtonElement).click();
    expect(cards()).toEqual(['c']);
    picker.set(all);
    expect(cards()).toEqual(['c']);
  });

  it('falls back to the first section when the open one has gone', () => {
    picker.set(all);
    (container.querySelectorAll('.prompt-tabs button')[1] as HTMLButtonElement).click();
    picker.set([prompt('Fix', 'a'), prompt('Plan', 'p')]);
    expect(container.querySelector('.prompt-tabs .active')!.textContent).toBe('Fix1');
  });

  it('lists every match under its heading, with no tabs, while a filter is typed, matching the section too', () => {
    picker.set(all);
    type('review');
    expect(container.querySelector('.prompt-tabs')).toBeNull();
    expect([...container.querySelectorAll('.prompt-group h3')].map((h) => h.textContent)).toEqual(['Review1']);
    expect(cards()).toEqual(['c']);
    type('');
    expect(tabs()).toEqual(['Fix2', 'Review1']);
  });
});
