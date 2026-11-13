import { describeWaiting, statusLabel } from '../../../shared/workspaces/attention';
import { caret, el } from '../ui/dom';
import { openBranchMenu } from './git-commits';
import { openCompare } from './git-diff';
import type { GitViewContext } from './git-view';

/** The branch line: the branch with its switch menu, sync counts, push, compare, the pull request chip and what claude is doing. */
export function renderStatus(ctx: GitViewContext): void {
  const { branchEl, state, pr } = ctx;
  branchEl.replaceChildren();
  if (!ctx.workspaceId) return;
  if (state) {
    const branch = el('button', '', 'git-branch-name');
    branch.type = 'button';
    branch.title = `${state.branch ?? 'detached HEAD'}\nSwitch branch`;
    branch.append(el('span', '⎇', 'git-branch-icon'), el('span', state.branch ?? 'detached HEAD'), caret(true));
    branch.addEventListener('click', () => openBranchMenu(ctx, branch));
    branchEl.append(branch);
    // Claude moves into worktrees on its own; say so when this is one, since it has its own branch and history.
    if (state.worktree) {
      const chip = el('span', `worktree · ${state.worktree}`, 'git-worktree');
      chip.title = `Claude is working in a linked worktree\n${state.root}`;
      branchEl.append(chip);
    }
    if (state.ahead) branchEl.append(el('span', `↑${state.ahead}`, 'git-sync'));
    if (state.behind) branchEl.append(el('span', `↓${state.behind}`, 'git-sync'));
    if (state.branch && (state.upstream === null || state.ahead > 0)) {
      const push = el('button', 'Push', 'git-chip-btn git-push');
      push.type = 'button';
      push.title = `Push ${state.branch} to origin`;
      push.disabled = ctx.pushing;
      push.addEventListener('click', () => {
        if (!ctx.workspaceId || ctx.pushing) return;
        ctx.pushing = true;
        push.disabled = true;
        ctx.send({ type: 'gitPush', id: ctx.workspaceId });
      });
      branchEl.append(push);
    }
    const compare = el('button', 'vs main', 'git-chip-btn');
    compare.type = 'button';
    compare.title = 'Everything this branch changes since it forked from its main branch';
    compare.addEventListener('click', () => openCompare(ctx));
    branchEl.append(compare);
    if (pr) {
      const { checks } = pr;
      const summary =
        !checks || checks.passed + checks.failed + checks.pending === 0
          ? ['no checks', '']
          : checks.failed
            ? [`✗ ${checks.failed} failing`, 'bad']
            : checks.pending
              ? [`● ${checks.pending} running`, 'wait']
              : [`✓ ${checks.passed} passing`, 'good'];
      const merged = pr.pr.state === 'MERGED';
      const chip = el(
        'button',
        merged ? `#${pr.pr.number} · merged` : `#${pr.pr.number}${pr.pr.isDraft ? ' draft' : ''} · ${summary[0]}`,
        `git-chip-btn ci ${merged ? 'merged' : summary[1]}`,
      );
      chip.type = 'button';
      chip.title = `${pr.pr.title}${checks?.failing.length ? `\nFailing: ${checks.failing.join(', ')}` : ''}\nOpen on GitHub`;
      chip.addEventListener('click', () => void chrome.tabs.create({ url: pr.pr.url }));
      branchEl.append(chip);
      // Merged means the work is done here; offer to put the workspace away.
      if (merged && ctx.archive) {
        const button = el('button', ctx.arming.isArmed('archive') ? 'Archive?' : 'Archive workspace', 'git-chip-btn git-archive');
        button.type = 'button';
        button.title = 'The pull request has merged. Archive this workspace (its tabs stay open).';
        button.addEventListener('click', () => {
          if (!ctx.workspaceId) return;
          if (ctx.arming.click('archive')) ctx.archive?.(ctx.workspaceId);
          else button.textContent = 'Archive?';
        });
        branchEl.append(button);
      }
    } else if (state.branch && ctx.checksBranch === state.branch) {
      // The lookup has answered for this branch and found none, so a pull request can be made.
      const create = el('button', 'Create PR', 'git-chip-btn git-create-pr');
      create.type = 'button';
      create.title = `Push ${state.branch} and open a draft pull request for it`;
      create.disabled = ctx.pushing;
      create.addEventListener('click', () => {
        if (!ctx.workspaceId || ctx.pushing) return;
        ctx.pushing = true;
        create.disabled = true;
        ctx.send({ type: 'gitCreatePr', id: ctx.workspaceId });
      });
      branchEl.append(create);
    }
  }
  const live = ctx.status(ctx.workspaceId);
  if (live) {
    const wanted = live === 'needs_input' ? (ctx.waiting?.(ctx.workspaceId) ?? null) : null;
    const chip = el('span', `Claude ${live === 'needs_input' ? '' : 'is '}${statusLabel(live, wanted)}`, 'git-claude');
    chip.dataset.status = live;
    if (wanted) chip.title = describeWaiting('Claude', wanted).message;
    branchEl.append(chip);
  }
}
