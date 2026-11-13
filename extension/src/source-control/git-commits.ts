import { layoutGraph } from '../../../shared/lib/git-graph';
import { el } from '../ui/dom';
import { menuItem, openMenu } from '../ui/menu';
import { hideRefCard, openCommit, showRefCard } from './git-diff';
import type { GitViewContext } from './git-view';
import { relative } from './pr-view';

const LANE_COLORS = ['#6fa3ff', '#4fcf8e', '#e5b84d', '#f26d6d', '#c58af9', '#78d9ec', '#fcad70', '#ff8bcb'];
const CELL = 12;
const ROW = 24;

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
};

/** Asks for the branches and opens the menu under the branch name, loading until they arrive. */
export function openBranchMenu(ctx: GitViewContext, anchor: HTMLElement): void {
  if (!ctx.workspaceId) return;
  ctx.send({ type: 'gitBranches', id: ctx.workspaceId });
  const box = anchor.getBoundingClientRect();
  openMenu(box.left, box.bottom + 2, [el('div', 'Loading branches…', 'popup-note')], 'branch-menu');
}

/** Fills the branch menu with the branches that arrived, if it is still open. */
export function showBranches(ctx: GitViewContext): void {
  if (!document.querySelector('.branch-menu')) return;
  const anchor = ctx.branchEl.querySelector<HTMLElement>('.git-branch-name');
  const box = anchor?.getBoundingClientRect();
  openMenu(
    box?.left ?? 8,
    (box?.bottom ?? 40) + 2,
    ctx.branches.length
      ? ctx.branches.map((b) =>
          menuItem(b.name, () => ctx.workspaceId && ctx.send({ type: 'gitSwitch', id: ctx.workspaceId, branch: b.name }), {
            checked: b.current,
            disabled: b.current,
            title: `${b.name}\n${b.upstream ? `tracks ${b.upstream}` : 'local only'}`,
          }),
        )
      : [el('div', 'No branches', 'popup-note')],
    'branch-menu',
  );
}

/** The recent commits, each with its place in the graph, its refs and its age; a click opens its diff. */
export function renderCommits(ctx: GitViewContext): void {
  const { commitsEl, state } = ctx;
  commitsEl.replaceChildren();
  if (!state || state.commits.length === 0) return;
  const heading = el('h3', 'Commits');
  heading.append(el('span', String(state.commits.length), 'count'));
  hideRefCard(ctx);
  const rows = layoutGraph(state.commits);
  const lanes = Math.max(1, ...rows.map((r) => r.width));
  commitsEl.append(
    heading,
    ...state.commits.map((commit, index) => {
      const { node, nodeColor, segments } = rows[index];
      const color = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
      const graph = svg('svg', { width: lanes * CELL + 4, height: ROW, class: 'git-graph' });
      const x = (column: number) => column * CELL + CELL / 2 + 2;
      for (const s of segments)
        graph.append(svg('line', { x1: x(s.x1), y1: s.y1 * ROW, x2: x(s.x2), y2: s.y2 * ROW, stroke: color(s.color), 'stroke-width': 1.6 }));
      const dot = svg('circle', { cx: x(node), cy: ROW / 2, r: 4, stroke: color(nodeColor), 'stroke-width': 1.6 });
      // A merge is drawn hollow, in the list's own color so it reads on either theme.
      if (commit.parents.length > 1) dot.style.fill = 'var(--list-bg)';
      else dot.setAttribute('fill', color(nodeColor));
      graph.append(dot);

      const row = el('button', '', 'git-commit');
      row.type = 'button';
      row.title = `${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}\n${commit.subject}`;
      const text = el('span', '', 'git-commit-text');
      text.append(el('span', commit.subject, 'git-subject'));
      if (commit.refs.length) {
        // The first ref is shown by name; any others fold into a count, so a small pane never fills with clipped pills.
        const refs = el('span', '', 'git-refs');
        const labels = commit.refs.map((ref) => ref.replace('HEAD -> ', ''));
        const toneOf = (ref: string) => (ref.startsWith('HEAD') ? ' head' : ref.startsWith('tag:') ? ' tag' : '');
        const first = el('span', labels[0], `git-ref${toneOf(commit.refs[0])}`);
        first.title = labels[0];
        refs.append(first);
        if (labels.length > 1) {
          const more = el('span', `+${labels.length - 1}`, 'git-ref more');
          more.setAttribute('aria-label', `${labels.length - 1} more: ${labels.slice(1).join(', ')}`);
          refs.append(more);
          // Instant, and listing every ref in its own colour, which a native tooltip is neither.
          refs.addEventListener('mouseenter', () => showRefCard(ctx, refs, commit.refs));
          refs.addEventListener('mouseleave', () => hideRefCard(ctx));
        }
        text.append(refs);
      }
      row.append(graph, text, el('span', relative(commit.date), 'git-when'));
      row.addEventListener('click', () => openCommit(ctx, commit));
      return row;
    }),
  );
}
