import type { GitCommit, GitCommitFile } from '../../../shared/protocol/protocol';
import { el } from '../ui/dom';
import type { GitViewContext } from './git-view';

const MAX_DIFF_LINES = 4000;

const LETTER_TONE: Record<string, string> = { M: 'mod', A: 'add', U: 'add', D: 'del', R: 'ren', C: 'ren', T: 'mod' };

/** A file in a list: name, folder and status letter, with optional actions that show on hover. */
export function fileRow(letter: string, path: string, from: string | undefined, onClick: () => void, fresh = false, actions: HTMLElement[] = []): HTMLElement {
  const row = el('div', '', `git-file${fresh ? ' fresh' : ''}`);
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  const slash = path.lastIndexOf('/');
  const name = el('span', path.slice(slash + 1), 'git-file-name');
  const dir = el('span', slash === -1 ? '' : path.slice(0, slash), 'git-file-dir');
  row.title = from ? `${from} → ${path}` : path;
  row.append(name, dir);
  if (actions.length) {
    const box = el('span', '', 'git-file-actions');
    box.append(...actions);
    box.addEventListener('click', (event) => event.stopPropagation());
    row.append(box);
  }
  row.append(el('span', letter, `git-letter ${LETTER_TONE[letter] ?? ''}`));
  row.addEventListener('click', onClick);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === row) onClick();
  });
  return row;
}

/** Opens the diff section with a title and a loading body, telling the panel if it was closed. */
function showDiffView(ctx: GitViewContext, title: string, meta: string): void {
  ctx.diffTitle.textContent = title;
  ctx.diffMeta.textContent = meta;
  ctx.diffFiles.replaceChildren();
  ctx.diffFiles.hidden = true;
  ctx.diffBody.replaceChildren(el('div', 'Loading…', 'git-empty'));
  ctx.diffSection.hidden = false;
  const wasOpen = ctx.isOpen;
  ctx.isOpen = true;
  if (!wasOpen) ctx.onToggle();
}

/** A working-tree file against HEAD. */
export function openWorking(ctx: GitViewContext, path: string): void {
  if (!ctx.workspaceId) return;
  ctx.comparing = false;
  ctx.openSha = null;
  ctx.openPath = path;
  showDiffView(ctx, path, 'Working tree against HEAD');
  ctx.send({ type: 'gitDiff', id: ctx.workspaceId, path });
}

/** A commit: its files are asked for, and the first one's diff shows once they arrive. */
export function openCommit(ctx: GitViewContext, commit: GitCommit): void {
  if (!ctx.workspaceId) return;
  ctx.comparing = false;
  ctx.openSha = commit.sha;
  ctx.openPath = null;
  showDiffView(ctx, commit.subject, `${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`);
  ctx.send({ type: 'gitCommit', id: ctx.workspaceId, sha: commit.sha });
}

/** Everything the branch changes since it forked from its main branch. */
export function openCompare(ctx: GitViewContext): void {
  if (!ctx.workspaceId) return;
  ctx.openSha = null;
  ctx.openPath = null;
  showDiffView(ctx, `${ctx.state?.branch ?? 'This branch'} vs main`, 'Everything this branch changes since it forked');
  ctx.comparing = true;
  ctx.send({ type: 'gitCompare', id: ctx.workspaceId });
}

/** Picks a file of the open commit or comparison and asks for its diff. */
export function selectCommitFile(ctx: GitViewContext, file: GitCommitFile): void {
  if (!ctx.workspaceId || (!ctx.openSha && !ctx.comparing)) return;
  ctx.openPath = file.path;
  for (const button of ctx.diffFiles.querySelectorAll<HTMLElement>('.git-file')) button.classList.toggle('selected', button.dataset.path === file.path);
  ctx.diffBody.replaceChildren(el('div', 'Loading…', 'git-empty'));
  ctx.send({ type: 'gitDiff', id: ctx.workspaceId, path: file.path, ...(ctx.openSha ? { sha: ctx.openSha } : { base: true }) });
}

/** Lists the files of the open commit or comparison and shows the first one's diff, or `whenEmpty` if there are none. */
export function listDiffFiles(ctx: GitViewContext, files: GitCommitFile[], whenEmpty: string): void {
  ctx.diffFiles.hidden = files.length === 0;
  ctx.diffFiles.replaceChildren(
    ...files.map((file) => {
      const row = fileRow(file.status, file.path, file.from, () => selectCommitFile(ctx, file));
      row.dataset.path = file.path;
      return row;
    }),
  );
  if (files[0]) selectCommitFile(ctx, files[0]);
  else ctx.diffBody.replaceChildren(el('div', whenEmpty, 'git-empty'));
}

/** Draws a unified diff line by line, with headers, hunks, additions and removals told apart; a long one is cut. */
export function renderDiff(ctx: GitViewContext, diff: string, truncated: boolean): void {
  if (!diff.trim()) {
    ctx.diffBody.replaceChildren(el('div', 'No textual changes (binary file, mode change or empty).', 'git-empty'));
    return;
  }
  const lines = diff.split('\n');
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const fragment = document.createDocumentFragment();
  for (const line of shown) {
    const meta = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line);
    const kind = meta ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    fragment.append(el('div', line || ' ', `diff-line ${kind}`));
  }
  if (truncated || lines.length > shown.length) fragment.append(el('div', 'Diff truncated.', 'git-empty'));
  ctx.diffBody.replaceChildren(fragment);
}

export function hideRefCard(ctx: GitViewContext): void {
  ctx.refCard?.remove();
  ctx.refCard = null;
}

/** Lists every ref of a commit in a card by its chips, replacing any card already showing. */
export function showRefCard(ctx: GitViewContext, anchor: HTMLElement, refs: readonly string[]): void {
  hideRefCard(ctx);
  const card = el('div', '', 'ref-card');
  for (const ref of refs) {
    const tone = ref.startsWith('HEAD') ? ' head' : ref.startsWith('tag:') ? ' tag' : '';
    card.append(el('span', ref.replace('HEAD -> ', ''), `git-ref${tone}`));
  }
  document.body.append(card);
  const box = anchor.getBoundingClientRect();
  const left = Math.max(4, Math.min(box.left, window.innerWidth - card.offsetWidth - 4));
  // Below the chips, or above them when there is no room.
  const below = box.bottom + 4;
  const top = below + card.offsetHeight > window.innerHeight - 4 ? Math.max(4, box.top - card.offsetHeight - 4) : below;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  ctx.refCard = card;
}
