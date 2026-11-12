import type { SystemSnapshot, UpdateStatus } from '../../shared/protocol';
import { el } from './dom';
import { formatCpu, formatDuration, formatKb } from './format';
import { actions, card, guarded, plain, row, type SettingsContext } from './settings-parts';

/** The last update check: its answer, whether one is running, and whether an update has just been applied. */
export interface UpdatesState {
  status: UpdateStatus | null;
  error: string | null;
  checking: boolean;
  applied: boolean;
}

/** What the Helper card remembers between redraws. */
export interface HelperState {
  /** The log's text while it is shown; null while hidden. Empty until the helper answers. */
  logText: string | null;
  updates: UpdatesState | null;
}

export const newHelperState = (): HelperState => ({ logText: null, updates: null });

const UNMANAGED = 'Started by hand, so launchd cannot restart it. Run npm run agent:start to manage it.';

/** The rows and buttons about this copy of the app being current: what runs, what the newest release is, and updating to it. */
function versionParts(ctx: SettingsContext, state: HelperState, commit: string | null): { rows: Node[]; notes: Node[]; buttons: HTMLButtonElement[] } {
  const { updates } = state;
  const check = plain(
    updates?.checking ? 'Checking…' : 'Check for updates',
    () => {
      state.updates = { status: updates?.status ?? null, error: null, checking: true, applied: false };
      ctx.send({ type: 'checkUpdates' });
      ctx.render();
    },
    'Fetches from the remote; nothing is changed',
  );
  check.disabled = updates?.checking === true;
  const { status, error } = updates ?? { status: null, error: null };

  if (updates?.applied) {
    const reload = plain('Reload extension', () => chrome.runtime.reload(), 'Finishes the update: the new panel code loads');
    return {
      rows: [row('Version', commit ?? 'unknown')],
      notes: [el('p', 'Updated. The helper is restarting, so every terminal ends; reload the extension to load the new panel.', 'settings-note')],
      buttons: [reload],
    };
  }
  if (error) return { rows: [row('Version', commit ?? 'unknown')], notes: [el('p', `Could not check: ${error}`, 'settings-note warn')], buttons: [check] };
  if (!status) {
    return {
      rows: [row('Version', commit ?? 'unknown')],
      notes: [],
      buttons: [check],
    };
  }

  const rows: Node[] = [row('Version', `${status.current} on ${status.branch}${status.upstream ? ` (tracks ${status.upstream})` : ''}`)];
  const notes: Node[] = [];
  if (status.release) rows.push(row('Latest release', status.release));
  if (status.behind === 0) notes.push(el('p', status.reason ?? 'Already up to date.', 'settings-note'));
  else {
    rows.push(row('Available', `${status.behind} new commit${status.behind === 1 ? '' : 's'}`));
    const list = el('div', '', 'update-commits');
    list.append(...status.commits.map((c) => el('div', `${c.short}  ${c.subject}`, 'update-commit')));
    if (status.behind > status.commits.length) list.append(el('div', `…and ${status.behind - status.commits.length} more`, 'update-commit more'));
    notes.push(list);
    if (!status.canUpdate && status.reason) notes.push(el('p', status.reason, 'settings-note warn'));
  }
  const apply = guarded(
    ctx,
    'apply-update',
    'Update now',
    'Update, rebuild and restart?',
    () => {
      state.updates = { status, error: null, checking: false, applied: true };
      ctx.request({ action: 'applyUpdate' });
      ctx.render();
    },
    { disabled: status.canUpdate ? undefined : (status.reason ?? 'Nothing to update.') },
  );
  return { rows, notes, buttons: [check, ...(status.behind > 0 ? [apply] : [])] };
}

/** The helper process, this copy of the app and its updates, the extension pairing, the review poller, and the log. */
export function helperCard(ctx: SettingsContext, state: HelperState, s: SystemSnapshot): HTMLElement {
  const { helper, reviews } = s;
  const version = versionParts(ctx, state, helper.commit);
  const matches = helper.extensionId === chrome.runtime.id;
  const reviewLine = reviews.fetchedAt
    ? `${reviews.count} PRs, fetched ${new Date(reviews.fetchedAt).toLocaleTimeString()}${reviews.error ? ` (last error: ${reviews.error.split('\n')[0]})` : ''}`
    : 'not fetched yet';
  const facts = el('div', '', 'kv-grid');
  facts.append(
    row('Status', el('span', 'Running', 'ok')),
    row('Process', `pid ${helper.pid}`),
    row('Uptime', formatDuration(helper.uptimeSec)),
    row('Memory', formatKb(helper.rssKb)),
    row('CPU', formatCpu(helper.cpu)),
    row('Port', String(helper.port)),
    row('Node', helper.node),
    ...version.rows,
    row('Connections', String(helper.clients)),
    row(
      'Extension ID',
      el('span', matches ? 'Matches this extension' : `Does not match this extension (${chrome.runtime.id})`, matches ? 'ok' : 'bad'),
      helper.extensionId,
    ),
    row('Review requests', reviewLine),
  );
  const debug = plain('Copy debug info', () => {
    const info = {
      extension: chrome.runtime.getManifest().version,
      helper: s.helper,
      storage: s.storage,
      sessions: s.sessions.map(({ id, pid, status, cwdMissing }) => ({ id, pid, status, cwdMissing })),
    };
    void navigator.clipboard.writeText(JSON.stringify(info, null, 2));
    ctx.showResult({ ok: true, message: 'Debug info copied.' });
  });
  // Empty until the helper answers; an empty log reads "(empty)", so a blank here means it is still loading.
  const log = el('pre', state.logText || 'Loading…', 'settings-log');
  return card(
    'Helper',
    facts,
    ...version.notes,
    actions(
      ...version.buttons,
      guarded(ctx, 'helper-restart', 'Restart helper', 'Ends every terminal. Restart?', () => ctx.request({ action: 'restartHelper' }), {
        disabled: helper.managed ? undefined : UNMANAGED,
      }),
      guarded(ctx, 'helper-stop', 'Stop helper', 'Stop until started again?', () => ctx.request({ action: 'stopHelper' }), {
        danger: true,
        disabled: helper.managed ? undefined : UNMANAGED,
      }),
    ),
    actions(
      plain('Refresh reviews', () => ctx.send({ type: 'refreshReviews' })),
      plain('Check GitHub CLI', () => ctx.request({ action: 'checkGh' }), 'Runs gh auth status'),
      debug,
      plain(state.logText === null ? 'Show log' : 'Hide log', () => {
        state.logText = state.logText === null ? '' : null;
        if (state.logText !== null) ctx.send({ type: 'systemLog' });
        ctx.render();
      }),
    ),
    ...(state.logText === null ? [] : [log]),
  );
}
