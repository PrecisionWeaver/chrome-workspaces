import type { ControlToClient, SystemSnapshot } from '../../../shared/protocol/protocol';
import type { ActivitySection } from '../activity/activity-section';
import type { CreateView } from '../create/create-view';
import type { SettingsView } from '../settings/settings-view';
import type { GitView } from '../source-control/git-view';
import { $, el } from '../ui/dom';
import { formatCpu, formatKb, formatUsageShort, resourceTitle, resourceTotal } from '../ui/format';
import type { WorkspaceList } from '../workspace-list/workspace-list';
import type { SessionAttachment } from './attach';
import type { PanelState } from './state';

/** The views a control message can be for. */
export interface MessageViews {
  creator: Pick<CreateView, 'setPrompts' | 'setTemplates' | 'setRepos' | 'setPrDetails' | 'setPrThreads'>;
  git: Pick<GitView, 'setState' | 'setCommit' | 'setDiff' | 'setResult' | 'setBranches' | 'setChecks' | 'setCompare' | 'refresh'>;
  settings: Pick<SettingsView, 'setTimeline' | 'setUpdates' | 'setSystem' | 'setResult' | 'setLog' | 'download' | 'warningCount' | 'setupRemaining'>;
  activity: Pick<ActivitySection, 'setActivity'>;
  workspaceList: Pick<WorkspaceList, 'render' | 'showSessions'>;
}

export interface MessageHandlerOptions {
  state: PanelState;
  views: MessageViews;
  session: Pick<SessionAttachment, 'attachedId' | 'detach'>;
  showNotice: (text: string) => void;
  /** Redraws the panel after a change to the state. */
  render: () => void;
}

/** Routes each message from the helper's control connection to the view it is for, and keeps the state current. */
export function createMessageHandler({ state, views, session, showNotice, render }: MessageHandlerOptions): (message: ControlToClient) => void {
  const { creator, git, settings, activity, workspaceList } = views;

  return (message) => {
    if (message.type === 'prompts') creator.setPrompts(message.prompts, message.error);
    if (message.type === 'templates') creator.setTemplates(message.templates, message.error);
    if (message.type === 'repos') creator.setRepos(message.repos);
    if (message.type === 'history') {
      state.history = message.entries;
      workspaceList.render();
    }
    if (message.type === 'timeline') settings.setTimeline(message);
    if (message.type === 'activity') activity.setActivity(message);
    if (message.type === 'updates') settings.setUpdates(message);
    if (message.type === 'system') {
      settings.setSystem(message);
      state.jiraBase = message.snapshot?.config.jiraBaseUrl ?? state.jiraBase;
      const attention = settings.warningCount + settings.setupRemaining;
      $<HTMLButtonElement>('settings-open').classList.toggle('has-warning', attention > 0);
      $<HTMLButtonElement>('settings-open').title = attention ? `Settings · ${attention} to look at` : 'Settings';
      showUsage(message.snapshot);
    }
    if (message.type === 'adminResult') settings.setResult(message);
    if (message.type === 'systemLog') settings.setLog(message.text);
    if (message.type === 'exportData') settings.download(message.json);
    if (message.type === 'sessionReset' && session.attachedId() === message.id) {
      // The helper replaced this workspace's session; attach to the new one.
      session.detach();
      render();
    }
    if (message.type === 'git') git.setState(message);
    if (message.type === 'gitCommit') git.setCommit(message);
    if (message.type === 'gitDiff') git.setDiff(message);
    if (message.type === 'gitResult') git.setResult(message);
    if (message.type === 'gitBranches') git.setBranches(message);
    if (message.type === 'gitChecks') git.setChecks(message);
    if (message.type === 'gitCompare') git.setCompare(message);
    if (message.type === 'prDetails') creator.setPrDetails(message.url, message.details, message.error);
    if (message.type === 'prThreads') creator.setPrThreads(message);
    if (message.type === 'createError') showNotice(message.message);
    if (message.type === 'sessions') workspaceList.showSessions(message);
    if (message.type !== 'state') return;
    state.selectJoiners(message.workspaces);
    const shown = state.current();
    const wasStatus = shown ? state.statuses[shown.id] : undefined;
    state.workspaces = message.workspaces;
    state.statuses = message.statuses;
    state.waiting = message.waiting;
    // Claude starting or finishing work means files likely changed.
    if (shown && state.statuses[shown.id] !== wasStatus) git.refresh();
    state.reviews = message.reviews;
    render();
  };
}

/** The helper's and every workspace's memory and CPU, rolled up in the list header; the same total as Settings. */
function showUsage(snapshot: SystemSnapshot | null): void {
  const usage = $<HTMLSpanElement>('list-usage');
  usage.hidden = !snapshot;
  if (!snapshot) return;
  const { kb, cpu } = resourceTotal(snapshot);
  usage.replaceChildren(...formatUsageShort(kb, cpu).map((text) => el('span', text)));
  usage.title = `${formatKb(kb)} · ${formatCpu(cpu)}\n${resourceTitle(snapshot)}`;
}
