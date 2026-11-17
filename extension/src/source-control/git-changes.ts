import type { GitFile, GitState } from '../../../shared/protocol/git';
import { confirmButton, el } from '../ui/dom';
import { keepFocus } from '../ui/focus';
import { fileRow, openWorking } from './git-diff';
import type { GitViewContext } from './git-view';

/** The files in the index, which a commit would take. */
export function stagedFiles(state: GitState | null): GitFile[] {
  return state?.files.filter((f) => f.index !== ' ' && f.index !== '?') ?? [];
}

/** A small button for a file or group. */
function iconButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const button = el('button', label, 'git-act');
  button.type = 'button';
  button.title = title;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

/** The working tree: staged and unstaged files with their stage, unstage and discard buttons, then the commit box. */
/** Draws the changed files; a button that was focused keeps focus through the redraw, so a two-click discard can be finished from the keyboard. */
export function renderChanges(ctx: GitViewContext): void {
  keepFocus(ctx.changesEl, () => drawChanges(ctx));
}

function drawChanges(ctx: GitViewContext): void {
  const { changesEl, state } = ctx;
  changesEl.replaceChildren();
  if (!state) return;
  const staged = stagedFiles(state);
  const unstaged = state.files.filter((f) => f.worktree !== ' ' || f.index === '?');
  const group = (title: string, files: GitFile[], letterOf: (f: GitFile) => string, all: HTMLElement[], each: (f: GitFile) => HTMLElement[]) => {
    if (files.length === 0) return;
    const heading = el('h3', title);
    heading.append(el('span', String(files.length), 'count'));
    const bulk = el('span', '', 'git-bulk');
    bulk.append(...all);
    heading.append(bulk);
    changesEl.append(heading, ...files.map((f) => fileRow(letterOf(f), f.path, f.from, () => openWorking(ctx, f.path), ctx.fresh.has(f.path), each(f))));
  };
  const stage = (paths: string[], on: boolean) => ctx.workspaceId && ctx.send({ type: 'gitStage', id: ctx.workspaceId, paths, stage: on });
  // Discarding cannot be undone, so the button asks twice; an untracked file is deleted outright, and says so.
  const discard = (f: GitFile) => {
    const key = `discard:${f.path}`;
    const ask = f.index === '?' ? 'Delete?' : 'Discard?';
    const button = el('button', '', 'git-act');
    button.title = f.index === '?' ? 'Delete this new file' : 'Discard changes';
    return confirmButton(
      ctx.arming,
      key,
      button,
      (armed) => (button.textContent = armed ? ask : '↶'),
      () => ctx.workspaceId && ctx.send({ type: 'gitDiscard', id: ctx.workspaceId, paths: [f.path] }),
    );
  };
  group(
    'Staged changes',
    staged,
    (f) => f.index,
    [iconButton('−', 'Unstage all', () => stage([], false))],
    (f) => [iconButton('−', 'Unstage', () => stage([f.path], false))],
  );
  group(
    'Changes',
    unstaged,
    (f) => (f.index === '?' ? 'U' : f.worktree),
    [iconButton('+', 'Stage all', () => stage([], true))],
    (f) => [discard(f), iconButton('+', 'Stage', () => stage([f.path], true))],
  );
  if (state.files.length === 0) changesEl.append(el('div', 'Working tree clean', 'git-empty'));
  renderSave(ctx, staged.length);
}

/** Shows the commit box while there is something staged or a message under way, and enables the button when both hold. */
export function renderSave(ctx: GitViewContext, stagedCount: number): void {
  const { saveBox, saveButton, messageInput } = ctx;
  // Kept once a message has been started, so staging another file does not take the box away.
  saveBox.hidden = stagedCount === 0 && !messageInput.value.trim();
  saveButton.disabled = stagedCount === 0 || !messageInput.value.trim();
  saveButton.title = stagedCount === 0 ? 'Stage something first' : `Commit ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`;
}

/** Commits what is staged with the message typed, once; the button stays off until the helper answers. */
export function commit(ctx: GitViewContext): void {
  if (!ctx.workspaceId || ctx.saveButton.disabled) return;
  ctx.send({ type: 'gitSave', id: ctx.workspaceId, message: ctx.messageInput.value });
  ctx.saveButton.disabled = true;
}
