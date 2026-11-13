import type { ControlToHelper, ReviewRequest, Workspace } from '../../../shared/protocol/protocol';
import { ticketUrl } from '../../../shared/lib/jira';
import { statusLabel } from '../../../shared/workspaces/attention';
import type { ActivitySection } from '../activity/activity-section';
import type { CreateView } from '../create/create-view';
import type { SettingsView } from '../settings/settings-view';
import type { GitView } from '../source-control/git-view';
import type { ToolView } from '../terminal/tool-view';
import { $ } from '../ui/dom';
import type { PaletteItem } from '../ui/palette';
import type { WorkspaceList } from '../workspace-list/workspace-list';
import type { PanelState } from './state';

export interface PaletteItemsOptions {
  state: Pick<PanelState, 'workspaces' | 'statuses' | 'waiting' | 'history' | 'reviews' | 'jiraBase' | 'current'>;
  send: (message: ControlToHelper) => void;
  creator: Pick<CreateView, 'show'>;
  tools: Pick<ToolView, 'show' | 'showShell'>;
  activity: Pick<ActivitySection, 'expand'>;
  settings: Pick<SettingsView, 'show'>;
  git: Pick<GitView, 'refresh'>;
  workspaceList: Pick<WorkspaceList, 'restore'>;
  openWorkspace: (workspace: Workspace) => void;
  startReview: (review: ReviewRequest) => void;
}

/** Everything the command palette offers: actions, then each workspace, ticket, archived workspace and review request. */
export function createPaletteItems({ state, send, creator, tools, activity, settings, git, workspaceList, openWorkspace, startReview }: PaletteItemsOptions) {
  return function paletteItems(): PaletteItem[] {
    const shown = state.current();
    const items: PaletteItem[] = [
      { kind: 'Action', label: 'New workspace', hint: 'Start a workspace', run: () => creator.show() },
      { kind: 'Action', label: 'Terminal', hint: 'A plain shell, not tied to a workspace', run: () => tools.show('shell') },
      ...(shown
        ? [
            {
              kind: 'Action',
              label: `Shell in ${shown.name}`,
              hint: 'A login shell in its directory, beside claude',
              run: () => tools.showShell(shown),
            },
          ]
        : []),
      { kind: 'Action', label: 'System monitor', hint: 'btop, in the panel', run: () => tools.show('monitor') },
      { kind: 'Action', label: 'Expand activity', hint: "What this workspace's claude is doing, as a timeline", run: () => activity.expand() },
      { kind: 'Action', label: 'Open settings', hint: 'Helper, sessions, housekeeping', run: () => settings.show() },
      { kind: 'Action', label: 'Refresh review requests', run: () => send({ type: 'refreshReviews' }) },
      { kind: 'Action', label: 'Refresh source control', run: () => git.refresh() },
      {
        kind: 'Action',
        label: document.body.classList.contains('collapsed') ? 'Expand the list' : 'Collapse the list',
        run: () => $<HTMLButtonElement>('collapse').click(),
      },
    ];
    for (const ws of state.workspaces) {
      const status = state.statuses[ws.id];
      items.push({
        kind: 'Workspace',
        label: ws.name,
        hint: [ws.id === shown?.id ? 'current' : '', status === 'idle' ? '' : statusLabel(status, state.waiting[ws.id]), ws.cwd.replace(/^\/Users\/[^/]+/, '~')]
          .filter(Boolean)
          .join(' · '),
        run: () => openWorkspace(ws),
      });
    }
    for (const ws of state.workspaces) {
      const url = ticketUrl(state.jiraBase, ws.ticket);
      if (url) items.push({ kind: 'Ticket', label: `${ws.ticket} · ${ws.name}`, hint: 'Open in Jira', run: () => void chrome.tabs.create({ url }) });
    }
    for (const entry of state.history) {
      items.push({
        kind: 'Restore',
        label: entry.name,
        hint: `closed ${new Date(entry.closedAt).toLocaleDateString()}${entry.resumeId ? ' · resumes its conversation' : ''}`,
        run: () => workspaceList.restore(entry),
      });
    }
    for (const review of state.reviews.items) {
      const existing = state.workspaces.find((ws) => ws.pr === review.url);
      items.push({
        kind: existing ? 'Review · has workspace' : 'Review',
        label: `${review.repo.split('/')[1] ?? review.repo}#${review.number} ${review.title}`,
        hint: review.author,
        run: () => (existing ? openWorkspace(existing) : startReview(review)),
      });
    }
    return items;
  };
}
