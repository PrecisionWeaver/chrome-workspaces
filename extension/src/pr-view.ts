import type { PrDetails, ReviewRequest } from '../../shared/protocol';
import { el } from './dom';

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
  return nodes;
}
