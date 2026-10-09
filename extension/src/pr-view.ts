import { PR_COMMITS_SHOWN, PR_FILES_SHOWN, type PrDetails, type ReviewRequest } from '../../shared/protocol';
import { el } from './dom';
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

/** Files and commits as collapsed counts, so the details stay brief until you open one. */
function glanceLists(pr: PrDetails): Node[] {
  const lists: Node[] = [];

  if (pr.files.length) {
    const files = el('details', '', 'glance');
    files.append(el('summary', `${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'} changed`));
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
    files.append(list);
    lists.push(files);
  }

  if (pr.commits.length) {
    const commits = el('details', '', 'glance');
    commits.append(el('summary', `${pr.commitCount} commit${pr.commitCount === 1 ? '' : 's'}`));
    const list = el('ul');
    for (const commit of pr.commits) {
      const row = el('li', '', 'glance-row');
      row.title = `${commit.sha} · ${commit.author}`;
      row.append(el('span', commit.headline, 'glance-name'), el('span', `${commit.author} · ${relative(commit.date)}`, 'glance-dir'));
      list.append(row);
    }
    const more = pr.commitCount - Math.min(pr.commits.length, PR_COMMITS_SHOWN);
    if (more > 0) list.append(el('li', `…and ${more} more`, 'glance-more'));
    commits.append(list);
    lists.push(commits);
  }
  return lists;
}
