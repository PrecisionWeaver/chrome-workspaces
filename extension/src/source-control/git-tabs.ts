import type { GitFile } from '../../../shared/protocol/git';
import { el } from '../ui/dom';
import { LETTER_TONE, openWorking } from './git-diff';
import type { GitViewContext } from './git-view';

/** A working-tree file opened in the diff view. A preview tab is the one the next file opened replaces, like VS Code's italic tab. */
export interface DiffTab {
  path: string;
  preview: boolean;
}

/** One workspace's open tabs, and the one showing. */
export interface TabSet {
  tabs: DiffTab[];
  active: string | null;
}

export const emptyTabs = (): TabSet => ({ tabs: [], active: null });

/** The diff showing is the working-tree file of the active tab; commits and comparisons have no tabs. */
const showingTab = (ctx: GitViewContext): boolean => ctx.isOpen && !ctx.openSha && !ctx.comparing && ctx.openPath !== null && ctx.openPath === ctx.tabs.active;

/** The status letter a tab shows: the working-tree change, else the staged one. */
function statusLetter(file: GitFile): string {
  if (file.index === '?') return 'U';
  return file.worktree !== ' ' ? file.worktree : file.index;
}

/**
 * Opens a working-tree file in a tab and shows its diff. A file already open is just shown; a new one replaces the preview
 * tab if there is one, else is added at the end. `pin` keeps the tab, so the next file opens beside it.
 */
export function openTab(ctx: GitViewContext, path: string, pin = false): void {
  const set = ctx.tabs;
  const existing = set.tabs.find((tab) => tab.path === path);
  if (existing) {
    if (pin) existing.preview = false;
  } else {
    const tab = { path, preview: !pin };
    const replaced = set.tabs.findIndex((other) => other.preview);
    if (replaced === -1) set.tabs.push(tab);
    else set.tabs[replaced] = tab;
  }
  set.active = path;
  openWorking(ctx, path);
  renderTabs(ctx);
}

/** Closes a tab. Closing the one showing moves to its right neighbour, else its left, and closing the last closes the diff view. */
export function closeTab(ctx: GitViewContext, path: string): void {
  const set = ctx.tabs;
  const index = set.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) return;
  const wasShowing = showingTab(ctx);
  set.tabs.splice(index, 1);
  if (set.active !== path) {
    renderTabs(ctx);
    return;
  }
  const next = set.tabs[index] ?? set.tabs[index - 1];
  set.active = next?.path ?? null;
  if (wasShowing && next) openWorking(ctx, next.path);
  renderTabs(ctx);
  if (wasShowing && !next) ctx.closeDiff();
}

/** Draws the strip, which only shows while a working-tree file is. A tab whose file no longer differs from HEAD is dimmed. */
export function renderTabs(ctx: GitViewContext): void {
  const strip = ctx.diffTabs;
  const { tabs, active } = ctx.tabs;
  strip.hidden = !(ctx.isOpen && !ctx.openSha && !ctx.comparing && tabs.length > 0);
  if (strip.hidden) {
    strip.replaceChildren();
    return;
  }
  strip.replaceChildren(
    ...tabs.map((tab) => {
      const file = ctx.state?.files.find((f) => f.path === tab.path);
      const isActive = tab.path === active;
      const item = el('div', '', `diff-tab${isActive ? ' active' : ''}${tab.preview ? ' preview' : ''}${file ? '' : ' clean'}`);
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(isActive));
      item.tabIndex = isActive ? 0 : -1;
      item.title = file ? tab.path : `${tab.path} (no changes)`;
      const close = el('button', '×', 'diff-tab-close');
      close.type = 'button';
      close.title = 'Close';
      close.setAttribute('aria-label', `Close ${tab.path}`);
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(ctx, tab.path);
      });
      item.append(el('span', tab.path.slice(tab.path.lastIndexOf('/') + 1), 'diff-tab-name'));
      if (file) {
        const letter = statusLetter(file);
        item.append(el('span', letter, `git-letter ${LETTER_TONE[letter] ?? ''}`));
      }
      item.append(close);
      item.addEventListener('click', () => openTab(ctx, tab.path));
      item.addEventListener('dblclick', () => openTab(ctx, tab.path, true));
      // A middle click closes, as in an editor; its mousedown would otherwise start the browser's autoscroll.
      item.addEventListener('mousedown', (event) => event.button === 1 && event.preventDefault());
      item.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        closeTab(ctx, tab.path);
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTab(ctx, tab.path);
          return;
        }
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        const neighbour = step ? ctx.tabs.tabs[ctx.tabs.tabs.findIndex((other) => other.path === tab.path) + step] : undefined;
        if (!neighbour) return;
        event.preventDefault();
        openTab(ctx, neighbour.path);
        strip.querySelector<HTMLElement>('.diff-tab.active')?.focus();
      });
      return item;
    }),
  );
}

/**
 * After a status answer: redraws the strip, and brings the diff showing up to date. A file whose status changed has a new
 * diff to ask for; one that no longer differs from HEAD has nothing left to show.
 */
export function syncTabs(ctx: GitViewContext, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): void {
  renderTabs(ctx);
  if (!showingTab(ctx)) return;
  const path = ctx.tabs.active as string;
  const now = after.get(path);
  if (now === before.get(path)) return;
  if (now === undefined) ctx.diffBody.replaceChildren(el('div', 'No changes: this file now matches HEAD.', 'git-empty'));
  else if (ctx.workspaceId) ctx.send({ type: 'gitDiff', id: ctx.workspaceId, path });
}
