import type { Prompt } from '../../../shared/protocol/workspace';
import { el, promptCard } from '../ui/dom';

export interface PromptPickerOptions {
  /** Where the prompts are drawn. */
  container: HTMLElement;
  /** The box that narrows them; the picker redraws as it is typed in. */
  filter: HTMLInputElement;
  onChoose(prompt: Prompt): void;
}

/**
 * The prompts of the New workspace view: a grid of cards, set apart by section behind tabs, or all at once under
 * their headings while a filter is typed (a filter searches every section, so it lists its matches rather than hiding them).
 */
export function createPromptPicker({ container, filter, onChoose }: PromptPickerOptions): { set(prompts: Prompt[]): void } {
  let prompts: Prompt[] = [];
  // The section whose prompts show when not filtering; kept between openings, so the usual one stays picked.
  let tab: string | null = null;

  function grid(items: Prompt[]): HTMLElement {
    const node = el('div', '', 'prompt-grid');
    node.append(
      ...items.map((prompt) => {
        const button = el('button', '', 'prompt');
        button.type = 'button';
        button.title = prompt.text;
        button.append(...promptCard(prompt.text));
        button.addEventListener('click', () => onChoose(prompt));
        return button;
      }),
    );
    return node;
  }

  function render(): void {
    const query = filter.value.trim().toLowerCase();
    const groups = new Map<string, Prompt[]>();
    for (const prompt of prompts) {
      if (query && !`${prompt.section} ${prompt.text}`.toLowerCase().includes(query)) continue;
      groups.set(prompt.section, [...(groups.get(prompt.section) ?? []), prompt]);
    }
    const label = (name: string) => name || 'Prompts';
    if (!query && groups.size > 1) {
      if (tab === null || !groups.has(tab)) tab = [...groups.keys()][0]!;
      const tabs = el('div', '', 'segmented prompt-tabs');
      tabs.append(
        ...[...groups].map(([name, items]) => {
          const button = el('button', label(name));
          button.type = 'button';
          button.classList.toggle('active', name === tab);
          button.append(el('span', String(items.length), 'count'));
          button.addEventListener('click', () => {
            tab = name;
            render();
          });
          return button;
        }),
      );
      // The row is rebuilt on every click, so it keeps the place it was scrolled to.
      const scrolled = container.querySelector('.prompt-tabs')?.scrollLeft ?? 0;
      container.replaceChildren(tabs, grid(groups.get(tab) ?? []));
      tabs.scrollLeft = scrolled;
      return;
    }
    container.replaceChildren(
      ...[...groups].map(([name, items]) => {
        const group = el('section', '', 'prompt-group');
        const heading = el('h3', label(name));
        heading.append(el('span', String(items.length), 'count'));
        group.append(heading, grid(items));
        return group;
      }),
    );
  }

  filter.addEventListener('input', render);

  return {
    set(next) {
      prompts = next;
      render();
    },
  };
}
