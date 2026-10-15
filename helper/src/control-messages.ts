import { MAX_PROMPT_LENGTH, MAX_TAB_URLS, MODEL_PATTERN, WORKSPACE_COLORS, type ControlToHelper } from '../../shared/protocol';
import { isPullRequestUrl } from './pr-workspace';

/** Validation of the messages an extension context sends to the helper; anything that fails is dropped. */

function isWindowId(value: unknown): value is number {
  return Number.isInteger(value);
}

function isWebUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^https?:\/\/\S+$/i.test(value);
}

function isWorkspaceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80;
}

function isPathList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 500 && value.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 1024);
}

const PLAIN_ACTIONS = new Set(['applyUpdate', 'restartHelper', 'stopHelper', 'clearUploads', 'clearLog', 'pruneWorktrees', 'checkGh']);

function isAdminAction(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.action !== 'string') return false;
  if (PLAIN_ACTIONS.has(r.action)) return true;
  if (r.action === 'restartSession') return typeof r.id === 'string';
  if (r.action === 'killProcess')
    return typeof r.id === 'string' && Number.isInteger(r.pid) && (r.pid as number) > 1 && (r.force === undefined || typeof r.force === 'boolean');
  return false;
}

export function isControlToHelper(value: unknown): value is ControlToHelper {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'pair':
      return typeof m.id === 'string' && isWindowId(m.windowId) && (m.groupId === undefined || isWindowId(m.groupId));
    case 'unpair':
      return isWindowId(m.windowId);
    case 'unpairGroup':
      return isWindowId(m.groupId);
    case 'tabs':
      return (
        isWindowId(m.windowId) && (m.groupId === undefined || isWindowId(m.groupId)) && Array.isArray(m.urls) && m.urls.every((u) => typeof u === 'string')
      );
    case 'remove':
      return typeof m.id === 'string' && (m.closeTabs === undefined || typeof m.closeTabs === 'boolean');
    case 'restore':
      return typeof m.historyId === 'string' && (m.windowId === null || isWindowId(m.windowId));
    case 'forget':
      return typeof m.historyId === 'string';
    case 'forgetAll':
      return true;
    case 'rename':
      return typeof m.id === 'string' && isWorkspaceName(m.name);
    case 'mark':
      return (
        typeof m.id === 'string' &&
        (m.pinned === undefined || typeof m.pinned === 'boolean') &&
        (m.color === undefined || m.color === null || (WORKSPACE_COLORS as readonly string[]).includes(m.color as string))
      );
    case 'sendText':
      return typeof m.id === 'string' && typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 100_000;
    case 'order':
      return Array.isArray(m.ids) && m.ids.length <= 500 && m.ids.every((id) => typeof id === 'string');
    case 'move':
      return typeof m.id === 'string' && Number.isInteger(m.index) && (m.index as number) >= 0;
    case 'create':
      return (
        isWorkspaceName(m.name) &&
        (m.windowId === null || isWindowId(m.windowId)) &&
        (m.pr === undefined || (typeof m.pr === 'string' && isPullRequestUrl(m.pr))) &&
        (m.prompt === undefined || (typeof m.prompt === 'string' && m.prompt.length <= MAX_PROMPT_LENGTH)) &&
        (m.cwd === undefined || (typeof m.cwd === 'string' && m.cwd.length <= 1024)) &&
        (m.model === undefined || (typeof m.model === 'string' && MODEL_PATTERN.test(m.model))) &&
        (m.color === undefined || (WORKSPACE_COLORS as readonly string[]).includes(m.color as string)) &&
        (m.group === undefined || typeof m.group === 'boolean') &&
        (m.urls === undefined || (Array.isArray(m.urls) && m.urls.length <= MAX_TAB_URLS && m.urls.every(isWebUrl)))
      );
    case 'timeline':
      return typeof m.id === 'string';
    case 'system':
    case 'systemLog':
    case 'exportData':
    case 'checkUpdates':
      return true;
    case 'admin':
      return isAdminAction(m.request);
    case 'git':
      return typeof m.id === 'string';
    case 'gitCommit':
      return typeof m.id === 'string' && typeof m.sha === 'string' && /^[0-9a-f]{7,40}$/.test(m.sha);
    case 'gitDiff':
      return (
        typeof m.id === 'string' &&
        typeof m.path === 'string' &&
        m.path.length > 0 &&
        m.path.length <= 1024 &&
        (m.sha === undefined || (typeof m.sha === 'string' && /^[0-9a-f]{7,40}$/.test(m.sha))) &&
        (m.base === undefined || typeof m.base === 'boolean')
      );
    case 'gitBranches':
    case 'gitChecks':
    case 'gitCompare':
      return typeof m.id === 'string';
    case 'gitStage':
      return typeof m.id === 'string' && typeof m.stage === 'boolean' && isPathList(m.paths);
    case 'gitDiscard':
      return typeof m.id === 'string' && isPathList(m.paths);
    case 'gitSave':
      return typeof m.id === 'string' && typeof m.message === 'string' && m.message.length <= 10_000;
    case 'gitSwitch':
      return typeof m.id === 'string' && typeof m.branch === 'string' && m.branch.length > 0 && m.branch.length <= 255;
    case 'listPrompts':
    case 'listRepos':
    case 'refreshReviews':
      return true;
    case 'prDetails':
    case 'prThreads':
      return typeof m.url === 'string' && isPullRequestUrl(m.url);
    default:
      return false;
  }
}
