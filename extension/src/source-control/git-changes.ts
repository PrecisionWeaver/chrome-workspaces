import type { GitFile, GitState } from '../../../shared/protocol/protocol';
import { el } from '../ui/dom';
import { fileRow, openWorking } from './git-diff';
import type { GitViewContext } from './git-view';

/** The files in the index, which a commit would take. */
export function stagedFiles(state: GitState | null): GitFile[] {
  return state?.files.filter((f) => f.index !== ' ' && f.index !== '?') ?? [];
}

/** A small button for a file or group; `armed` draws it as one waiting for its confirming click. */
function iconButton(label: string, title: string, run: () => void, armed = false): HTMLButtonElement {
  const button = el('button', label, `git-act${armed ? ' armed' : ''}`);
  button.type = 'button';
  button.title = title;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

/** The working tree: staged and unstaged files with their stage, unstage and discard buttons, then the commit box. */
export function renderChanges(ctx: GitViewContext): void {
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
    const button = iconButton(
      ctx.arming.isArmed(key) ? ask : '↶',
      f.index === '?' ? 'Delete this new file' : 'Discard changes',
      () => {
        if (ctx.arming.click(key)) {
          if (ctx.workspaceId) ctx.send({ type: 'gitDiscard', id: ctx.workspaceId, paths: [f.path] });
          return;
        }
        button.textContent = ask;
        button.classList.add('armed');
      },
      ctx.arming.isArmed(key),
    );
    return button;
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
