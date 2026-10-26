import { PR_COMMITS_SHOWN, PR_FILES_SHOWN, type PrDetails, type PrThread, type ReviewRequest } from '../../shared/protocol';
import { caret, el } from './dom';
import { renderMarkdown } from './markdown-view';

export const repoName = (review: ReviewRequest) => review.repo.split('/')[1] ?? review.repo;
export const ref = (review: ReviewRequest) => `${repoName(review)}#${review.number}`;

const DECISIONS: Record<string, [label: string, tone: string]> = {
  APPROVED: ['Approved', 'good'],
  CHANGES_REQUESTED: ['Changes requested', 'bad'],
  REVIEW_REQUIRED: ['Review required', 'wait'],
};
const REVIEW_STATES: Record<string, [label: string, tone: string]> = {
  APPROVED: ['approved', 'good'],
  CHANGES_REQUESTED: ['requested changes', 'bad'],
  COMMENTED: ['commented', ''],
  DISMISSED: ['dismissed', ''],
  PENDING: ['review in progress', 'wait'],
};

export function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** A line of text led by its author's name in bold. */
export function byline(text: string, author: string, prefix = ''): HTMLElement {
  const line = el('span', prefix, 'when');
  line.append(el('strong', author, 'author'), ` · ${text}`);
  return line;
}

function person(login: string, trailing?: Node): HTMLElement {
  const row = el('li', '', 'person');
  row.append(el('span', login.slice(0, 1).toUpperCase(), 'avatar'), el('span', login, 'login'));
  if (trailing) row.append(trailing);
  return row;
}

export function renderDetails(pr: PrDetails): Node[] {
  const branches = el('div', '', 'branches');
  branches.append(el('code', pr.head), el('span', '→', 'arrow'), el('code', pr.base));

  const stats = el('div', '', 'stats');
  stats.append(
    el('span', `+${pr.additions.toLocaleString()}`, 'add'),
    el('span', `−${pr.deletions.toLocaleString()}`, 'del'),
    el('span', `${pr.changedFiles} files`, 'files'),
    byline(`opened ${relative(pr.createdAt)} · updated ${relative(pr.updatedAt)}`, pr.author, 'by '),
  );
  if (pr.comments) stats.append(el('span', `${pr.comments} comment${pr.comments === 1 ? '' : 's'}`, 'comments'));

  const pills = el('div', '', 'pills');
  const [label, tone] = DECISIONS[pr.reviewDecision ?? ''] ?? ['No review required', ''];
  pills.append(el('span', label, `pill ${tone}`));
  if (pr.isDraft) pills.append(el('span', 'Draft', 'pill'));
  if (pr.mergeable === 'CONFLICTING') pills.append(el('span', 'Merge conflicts', 'pill bad'));
  const { passed, failed, pending, failing } = pr.checks;
  if (failed) pills.append(el('span', `${failed} failing`, 'pill bad'));
  if (pending) pills.append(el('span', `${pending} pending`, 'pill wait'));
  if (passed) pills.append(el('span', `${passed} passed`, 'pill good'));

  const nodes: Node[] = [branches, stats, pills];
  if (pr.labels.length) {
    const labels = el('div', '', 'labels');
    labels.append(...pr.labels.map((name) => el('span', name, 'label')));
    nodes.push(labels);
  }
  if (pr.body.trim()) nodes.push(renderMarkdown(pr.body));
  if (failing.length) {
    const failingEl = el('div', 'Failing: ', 'failing');
    failingEl.append(el('span', failing.join(', ')));
    nodes.push(failingEl);
  }

  const people = el('div', '', 'people');
  const reviewed = el('div', '', 'people-col');
  reviewed.append(el('h3', 'Reviews'));
  const reviewList = el('ul');
  if (pr.reviews.length === 0) reviewList.append(el('li', 'None yet', 'empty'));
  for (const r of pr.reviews) {
    const [stateLabel, stateTone] = REVIEW_STATES[r.state] ?? [r.state.toLowerCase(), ''];
    const row = person(r.login, el('span', stateLabel, `state ${stateTone}`));
    if (r.at) row.title = new Date(r.at).toLocaleString();
    reviewList.append(row);
  }
  reviewed.append(reviewList);
  people.append(reviewed);

  if (pr.requested.length) {
    const waiting = el('div', '', 'people-col');
    waiting.append(el('h3', `Waiting on ${pr.requested.length}`));
    const waitingList = el('ul');
    waitingList.append(...pr.requested.map((login) => person(login)));
    waiting.append(waitingList);
    people.append(waiting);
  }
  nodes.push(people);
  nodes.push(...glanceLists(pr));
  return nodes;
}

/**
 * A collapsed <details> section: a heading led by the shared caret in place of the browser's own triangle,
 * then its body. Every list in the card (files, commits, review comments) is one of these.
 */
function fold(heading: string, body: Node, ...badges: Node[]): HTMLDetailsElement {
  const details = el('details', '', 'glance');
  const summary = el('summary', '');
  summary.append(caret(false), heading, ...badges);
  details.append(summary, body);
  return details;
}

/** The padded body of a fold, for content that isn't a plain list. */
function foldBody(...children: Node[]): HTMLElement {
  const body = el('div', '', 'glance-body');
  body.append(...children);
  return body;
}

/** Files and commits as collapsed counts, so the details stay brief until you open one. */
function glanceLists(pr: PrDetails): Node[] {
  const lists: Node[] = [];

  if (pr.files.length) {
    const list = el('ul');
    for (const file of pr.files) {
      const slash = file.path.lastIndexOf('/');
      const row = el('li', '', 'glance-row');
      row.title = file.path;
      row.append(
        el('span', file.path.slice(slash + 1), 'glance-name'),
        el('span', slash === -1 ? '' : file.path.slice(0, slash), 'glance-dir'),
        el('span', `+${file.additions}`, 'add'),
        el('span', `−${file.deletions}`, 'del'),
      );
      list.append(row);
    }
    const more = pr.changedFiles - Math.min(pr.files.length, PR_FILES_SHOWN);
    if (more > 0) list.append(el('li', `…and ${more} more`, 'glance-more'));
    lists.push(fold(`${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'} changed`, list));
  }

  if (pr.commits.length) {
    const list = el('ul');
    for (const commit of pr.commits) {
      const row = el('li', '', 'glance-row');
      row.title = `${commit.sha} · ${commit.author}`;
      row.append(el('span', commit.headline, 'glance-name'), el('span', `${commit.author} · ${relative(commit.date)}`, 'glance-dir'));
      list.append(row);
    }
    const more = pr.commitCount - Math.min(pr.commits.length, PR_COMMITS_SHOWN);
    if (more > 0) list.append(el('li', `…and ${more} more`, 'glance-more'));
    lists.push(fold(`${pr.commitCount} commit${pr.commitCount === 1 ? '' : 's'}`, list));
  }
  return lists;
}

/**
 * A pull request's review threads, read-only: open ones first and shown, resolved ones folded under their
 * count. Each comment links to GitHub, where it can be answered.
 */
export function renderThreads(threads: readonly PrThread[], total: number): Node[] {
  if (threads.length === 0) return [el('div', 'No review comments.', 'threads-empty')];
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const card = (thread: PrThread): HTMLElement => {
    const box = el('div', '', `thread${thread.resolved ? ' resolved' : ''}`);
    const where = el('button', `${thread.path}${thread.line ? `:${thread.line}` : ''}`, 'thread-where');
    where.type = 'button';
    where.title = 'Open on GitHub';
    where.addEventListener('click', () => thread.comments[0]?.url && void chrome.tabs.create({ url: thread.comments[0].url }));
    box.append(where);
    if (thread.outdated) box.append(el('span', 'outdated', 'thread-flag'));
    for (const comment of thread.comments) {
      const line = el('div', '', 'thread-comment');
      const head = el('div', '', 'thread-head');
      head.append(el('strong', comment.author, 'author'), el('span', comment.at ? relative(comment.at) : '', 'thread-when'));
      line.append(head, renderMarkdown(comment.body, 320));
      box.append(line);
    }
    return box;
  };

  const body = foldBody(...open.map(card));
  if (resolved.length) body.append(fold(`${resolved.length} resolved thread${resolved.length === 1 ? '' : 's'}`, foldBody(...resolved.map(card))));
  if (total > threads.length) body.append(el('div', `Showing ${threads.length} of ${total} threads.`, 'threads-empty'));

  const badges = [el('span', open.length ? `${open.length} open` : 'all resolved', `thread-count${open.length ? ' open' : ''}`)];
  if (resolved.length) badges.push(el('span', `${resolved.length} resolved`, 'thread-count'));
  return [fold('Review comments', body, ...badges)];
}
