import type { TimelineEvent } from '../../shared/timeline';
import type {
  AdminAction,
  ControlToClient,
  ControlToHelper,
  SystemProcess,
  SystemSession,
  SystemSnapshot,
  TokenTotals,
  UpdateStatus,
} from '../../shared/protocol';
import { caret, el } from './dom';
import { card, actions, row } from './settings-parts';
import { planCard, usageCard } from './settings-usage';
import { formatBytes, formatDuration, formatKb, formatTokens, newTokens } from './format';
import { DENSITIES, THEMES } from '../../shared/keynav';
import { formatUsd } from '../../shared/pricing';
import { buildChecklist, remaining, type SetupItem } from '../../shared/onboarding';
import { loadPrefs, normalizePrefs, savePrefs, type Prefs } from './prefs';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface SettingsViewOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
}

export interface SettingsView {
  readonly isOpen: boolean;
  show(): void;
  close(): void;
  setSystem(message: Extract<ControlToClient, { type: 'system' }>): void;
  /** How many warnings the last snapshot had, for a marker on the settings button. */
  readonly warningCount: number;
  /** How many setup steps are still open, 0 once everything is done or the checklist is dismissed. */
  readonly setupRemaining: number;
  setTimeline(message: Extract<ControlToClient, { type: 'timeline' }>): void;
  setUpdates(message: Extract<ControlToClient, { type: 'updates' }>): void;
  setResult(message: Extract<ControlToClient, { type: 'adminResult' }>): void;
  setLog(text: string): void;
  download(json: string): void;
}

const POLL_MS = 3000;
// A destructive button turns into a confirmation for this long before it disarms.
const ARM_MS = 4000;

const tokenBreakdown = (t: TokenTotals): string =>
  `input ${t.input.toLocaleString()} · output ${t.output.toLocaleString()} · cache written ${t.cacheWrite.toLocaleString()} · cache read ${t.cacheRead.toLocaleString()}`;

const STATUS_LABEL = { working: 'working', needs_input: 'needs input', idle: 'idle' } as const;

export function createSettingsView({ send, onToggle }: SettingsViewOptions): SettingsView {
  const section = $<HTMLElement>('settings');
  const body = $<HTMLDivElement>('settings-body');
  const grid = $<HTMLDivElement>('settings-cards');
  const resultEl = $<HTMLDivElement>('settings-result');
  const updatedEl = $<HTMLSpanElement>('settings-updated');

  let isOpen = false;
  let snapshot: SystemSnapshot | null = null;
  let error: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let resultTimer: ReturnType<typeof setTimeout> | undefined;
  let logText: string | null = null;
  // The last update check: its answer, whether one is running, and whether an update has just been applied.
  let updates: { status: UpdateStatus | null; error: string | null; checking: boolean; applied: boolean } | null = null;
  let prefs: Prefs = normalizePrefs(undefined);
  // Read once per snapshot; the shortcut is a browser setting the helper cannot see.
  let switchShortcut = '';
  const readShortcut = () => chrome.commands.getAll().then((commands) => (switchShortcut = commands.find((c) => c.name === 'next-workspace')?.shortcut ?? ''));
  void readShortcut();
  void loadPrefs().then((loaded) => {
    prefs = loaded;
    if (isOpen) render();
  });
  const expanded = new Set<string>();
  // Sessions whose activity list is open, and what each last returned.
  const activityOpen = new Set<string>();
  const activity = new Map<string, { events: TimelineEvent[]; error: string | null }>();
  const armed = new Set<string>();

  const request = (action: AdminAction): void => {
    send({ type: 'admin', request: action });
  };

  /** A button that asks again before doing something destructive. */
  function guarded(
    key: string,
    label: string,
    confirmLabel: string,
    run: () => void,
    options: { danger?: boolean; disabled?: string } = {},
  ): HTMLButtonElement {
    const isArmed = armed.has(key);
    const button = el('button', isArmed ? confirmLabel : label, `settings-btn${options.danger ? ' danger' : ''}${isArmed ? ' armed' : ''}`);
    button.type = 'button';
    if (options.disabled) {
      button.disabled = true;
      button.title = options.disabled;
    }
    button.addEventListener('click', () => {
      if (armed.has(key)) {
        armed.delete(key);
        run();
      } else {
        armed.add(key);
        setTimeout(() => {
          armed.delete(key);
          render();
        }, ARM_MS);
      }
      render();
    });
    return button;
  }

  function plain(label: string, run: () => void, title = ''): HTMLButtonElement {
    const button = el('button', label, 'settings-btn');
    button.type = 'button';
    button.title = title;
    button.addEventListener('click', run);
    return button;
  }

  // ---- sections ----

  function helperCard(s: SystemSnapshot): HTMLElement {
    const { helper } = s;
    const facts = el('div', '', 'kv-grid');
    facts.append(
      row('Status', el('span', 'Running', 'ok')),
      row('Process', `pid ${helper.pid}`),
      row('Uptime', formatDuration(helper.uptimeSec)),
      row('Memory', formatKb(helper.rssKb)),
      row('Port', String(helper.port)),
      row('Node', helper.node),
      row('Version', helper.commit ?? 'unknown'),
      row('Connections', String(helper.clients)),
    );
    const unmanaged = 'Started by hand, so launchd cannot restart it. Run npm run agent:start to manage it.';
    // Empty until the helper answers; an empty log reads "(empty)", so a blank here means it is still loading.
    const log = el('pre', logText || 'Loading…', 'settings-log');
    return card(
      'Helper',
      facts,
      actions(
        guarded('helper-restart', 'Restart helper', 'Ends every terminal. Restart?', () => request({ action: 'restartHelper' }), {
          disabled: helper.managed ? undefined : unmanaged,
        }),
        guarded('helper-stop', 'Stop helper', 'Stop until started again?', () => request({ action: 'stopHelper' }), {
          danger: true,
          disabled: helper.managed ? undefined : unmanaged,
        }),
        plain(logText === null ? 'Show log' : 'Hide log', () => {
          logText = logText === null ? '' : null;
          if (logText !== null) send({ type: 'systemLog' });
          render();
        }),
      ),
      ...(logText === null ? [] : [log]),
    );
  }

  function processRow(session: SystemSession, proc: SystemProcess, isShell: boolean): HTMLElement {
    const line = el('div', '', `proc${isShell ? ' shell' : ''}`);
    line.append(el('span', String(proc.pid), 'pid'), el('span', proc.command, 'cmd'));
    line.title = proc.command;
    const meta = el('span', '', 'proc-meta');
    for (const port of proc.ports) {
      const chip = el('button', `:${port}`, 'port');
      chip.type = 'button';
      chip.title = `Open localhost:${port}`;
      chip.addEventListener('click', () => void chrome.tabs.create({ url: `http://localhost:${port}` }));
      meta.append(chip);
    }
    meta.append(el('span', `${proc.cpu.toFixed(1)}%`, 'num'), el('span', formatKb(proc.rssKb), 'num'), el('span', proc.elapsed, 'num'));
    line.append(meta);
    if (!isShell) {
      const kill = el('span', '', 'proc-actions');
      kill.append(
        guarded(`stop-${proc.pid}`, 'Stop', 'Stop it and its children?', () => request({ action: 'killProcess', id: session.id, pid: proc.pid })),
        guarded(`kill-${proc.pid}`, 'Force', 'Force kill (SIGKILL)?', () => request({ action: 'killProcess', id: session.id, pid: proc.pid, force: true }), {
          danger: true,
        }),
      );
      line.append(kill);
    }
    return line;
  }

  const clock = (iso: string): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const KIND_LABEL = { you: 'You', said: 'Claude', tool: '' } as const;

  /** What a session has recently done: the files it changed, then each event with its time, newest first. */
  function activityList(session: SystemSession): HTMLElement {
    const box = el('div', '', 'activity');
    const found = activity.get(session.id);
    if (!found) return Object.assign(box, { textContent: 'Loading…' });
    if (found.error) return Object.assign(box, { textContent: found.error });
    if (found.events.length === 0) return Object.assign(box, { textContent: 'Nothing yet.' });

    const changed = [...new Set(found.events.filter((e) => e.kind === 'tool' && e.file && e.tool !== 'Read').map((e) => e.file as string))];
    if (changed.length) {
      const files = el('div', '', 'activity-files');
      files.append(el('span', `Changed ${changed.length} file${changed.length === 1 ? '' : 's'}: `, 'k'));
      files.append(el('span', changed.map((f) => f.split('/').pop()).join(', '), 'v'));
      files.title = changed.join('\n');
      box.append(files);
    }
    for (const event of [...found.events].reverse()) {
      const line = el('div', '', `activity-row ${event.kind}`);
      line.append(
        el('span', clock(event.at), 'activity-time'),
        el('span', event.kind === 'tool' ? event.tool : KIND_LABEL[event.kind], 'activity-kind'),
        el('span', event.summary, 'activity-text'),
      );
      line.title = event.summary;
      box.append(line);
    }
    return box;
  }

  function sessionRow(session: SystemSession): HTMLElement {
    const running = session.pid !== null;
    const open = expanded.has(session.id) && running;
    const wrapper = el('div', '', 'session');

    const head = el('div', '', 'session-head');
    const toggle = el('button', '', 'session-toggle');
    if (running) toggle.append(caret(open));
    toggle.type = 'button';
    toggle.disabled = !running;
    toggle.addEventListener('click', () => {
      if (open) expanded.delete(session.id);
      else expanded.add(session.id);
      render();
    });
    const memory = session.processes.reduce((sum, p) => sum + p.rssKb, 0);
    const ports = session.processes.flatMap((p) => p.ports);
    const summary = el('span', '', 'session-summary');
    summary.append(el('span', session.name, 'session-name'));
    const status = session.status && running ? el('span', STATUS_LABEL[session.status], `chip ${session.status}`) : null;
    if (status) summary.append(status);
    if (session.cwdMissing) summary.append(el('span', 'directory missing', 'chip bad'));
    if (session.tokens) {
      const cost = session.tokens.costUsd > 0 ? ` · ~${formatUsd(session.tokens.costUsd)}` : '';
      const tokens = el('span', session.tokens.counting ? 'counting tokens…' : `${formatTokens(newTokens(session.tokens))} tokens${cost}`, 'session-tokens');
      tokens.title = `${tokenBreakdown(session.tokens)}\nCache reads are repeats of earlier input, so they are not in the headline figure.${cost ? '\nThe dollar figure is an estimate, using the rates under "pricing" in the config.' : ''}`;
      summary.append(tokens);
    }
    summary.append(
      el(
        'span',
        running
          ? `${session.processes.length} process${session.processes.length === 1 ? '' : 'es'} · ${formatKb(memory)}${ports.length ? ` · ${ports.map((p) => `:${p}`).join(' ')}` : ''}`
          : 'not running',
        'session-detail',
      ),
    );
    summary.title = session.cwd;
    head.append(
      toggle,
      summary,
      guarded(`restart-${session.id}`, 'Restart', 'End its shell?', () => request({ action: 'restartSession', id: session.id }), {
        disabled: running ? undefined : 'No session is running; it starts when the workspace is opened.',
      }),
    );
    wrapper.append(head);

    if (open) {
      const list = el('div', '', 'procs');
      session.processes.forEach((proc, index) => {
        list.append(processRow(session, proc, index === 0));
      });
      wrapper.append(list);
    }
    if (open) {
      const shown = activityOpen.has(session.id);
      const toggle = plain(
        shown ? 'Hide activity' : 'Show activity',
        () => {
          if (shown) activityOpen.delete(session.id);
          else {
            activityOpen.add(session.id);
            send({ type: 'timeline', id: session.id });
          }
          render();
        },
        "What this session's claude has recently done",
      );
      wrapper.append(actions(toggle));
      if (shown) wrapper.append(activityList(session));
    }
    return wrapper;
  }

  function sessionsCard(s: SystemSnapshot): HTMLElement {
    const running = s.sessions.filter((x) => x.pid !== null).length;
    const counted = s.sessions.flatMap((x) => (x.tokens && !x.tokens.counting ? [x.tokens] : []));
    const total = counted.reduce((sum, t) => sum + newTokens(t), 0);
    const workspaceKb = s.sessions.reduce((sum, x) => sum + x.processes.reduce((n, p) => n + p.rssKb, 0), 0);
    const list = el('div', '', 'sessions');
    // Running workspaces first, since those are the ones using the machine.
    list.append(...[...s.sessions].sort((a, b) => Number(b.pid !== null) - Number(a.pid !== null)).map(sessionRow));
    if (s.sessions.length === 0) list.append(el('div', 'No workspaces yet.', 'settings-empty'));
    return card(
      `Workspace sessions · ${running} running${counted.length ? ` · ${formatTokens(total)} tokens` : ''}${running ? ` · ${formatKb(workspaceKb)}` : ''}`,
      el(
        'p',
        'Each runs a shell and claude, and shows the tokens that claude session has used (input, output and cache writes; hover for the breakdown). Expand one to see every process beneath it, and the ports they listen on. Stopping a process also stops its children.',
        'settings-note',
      ),
      list,
      memoryTotal(s.helper.rssKb, workspaceKb),
    );
  }

  /** Helper plus every workspace's processes. RSS counts shared pages once per process, so it runs a little high. */
  function memoryTotal(helperKb: number, workspaceKb: number): HTMLElement {
    const line = el('div', '', 'memory-total');
    line.append(el('span', 'Total memory', 'k'), el('span', formatKb(helperKb + workspaceKb), 'v'));
    line.title = `Helper ${formatKb(helperKb)} + workspaces ${formatKb(workspaceKb)}\nMemory shared between processes is counted once per process, so this is slightly high.`;
    return line;
  }

  function housekeepingCard(s: SystemSnapshot): HTMLElement {
    const reviewLine = s.reviews.fetchedAt
      ? `${s.reviews.count} PRs, fetched ${new Date(s.reviews.fetchedAt).toLocaleTimeString()}${s.reviews.error ? ` (last error: ${s.reviews.error.split('\n')[0]})` : ''}`
      : 'not fetched yet';
    return card(
      'Housekeeping',
      row('Uploads', formatBytes(s.storage.uploadsBytes), 'Files dropped or pasted into terminals; deleted after a week'),
      row('Helper log', formatBytes(s.storage.logBytes)),
      row('Data folder', formatBytes(s.storage.dataBytes)),
      row('Review requests', reviewLine),
      actions(
        guarded('clear-uploads', 'Clear uploads', 'Delete all uploads?', () => request({ action: 'clearUploads' })),
        guarded('clear-log', 'Clear log', 'Empty the log?', () => request({ action: 'clearLog' })),
        plain(
          'Prune worktrees',
          () => request({ action: 'pruneWorktrees' }),
          "Removes git records of worktrees whose folders are gone, in each workspace's repository",
        ),
        plain('Refresh reviews', () => send({ type: 'refreshReviews' })),
        plain('Export workspaces', () => send({ type: 'exportData' }), 'Downloads the workspace list as JSON'),
      ),
    );
  }

  function configCard(s: SystemSnapshot): HTMLElement {
    const { config, helper } = s;
    const map = (record: Record<string, string>) =>
      Object.keys(record).length
        ? Object.entries(record)
            .map(([k, v]) => `${k} → ${v}`)
            .join('\n')
        : 'none';
    const mono = (text: string) => el('span', text, 'mono');
    return card(
      'Configuration',
      el('p', `Read from ${helper.configPath}. Edit it and restart the helper to change these.`, 'settings-note'),
      row('Default directory', mono(config.defaultCwd)),
      row('Prompts file', mono(config.promptsFile)),
      row('Default model', config.defaultModel ?? "claude's own"),
      row('Command', config.claudeCommand),
      row('Repo folders', mono(config.repoRoots.join('\n') || 'none')),
      row('Repo directories', mono(map(config.repoDirs))),
      row('Watched repos', mono(config.watchRepos.join('\n') || 'none')),
      row(
        'Prices',
        mono(
          Object.entries(config.pricing)
            .map(([family, r]) => `${family}: $${r.input} in / $${r.output} out`)
            .join('\n'),
        ),
      ),
      row('Warn above', `${config.limits.memoryWarnMb} MB per workspace · servers idle ${config.limits.idleServerHours} h`),
    );
  }

  function diagnosticsCard(s: SystemSnapshot): HTMLElement {
    const matches = s.helper.extensionId === chrome.runtime.id;
    const verdict = el('span', matches ? 'Matches this extension' : `Does not match this extension (${chrome.runtime.id})`, matches ? 'ok' : 'bad');
    return card(
      'Diagnostics',
      row('Extension ID', verdict, s.helper.extensionId),
      actions(
        plain('Check GitHub CLI', () => request({ action: 'checkGh' }), 'Runs gh auth status'),
        plain('Copy debug info', () => {
          const info = {
            extension: chrome.runtime.getManifest().version,
            helper: s.helper,
            storage: s.storage,
            sessions: s.sessions.map(({ id, pid, status, cwdMissing }) => ({ id, pid, status, cwdMissing })),
          };
          void navigator.clipboard.writeText(JSON.stringify(info, null, 2));
          showResult({ ok: true, message: 'Debug info copied.' });
        }),
      ),
    );
  }

  function checkbox(label: string, checked: boolean, onChange: (value: boolean) => void, hint = ''): HTMLElement {
    const wrapper = el('label', '', 'pref');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    wrapper.append(box, el('span', label, 'pref-label'));
    if (hint) wrapper.append(el('span', hint, 'pref-hint'));
    return wrapper;
  }

  function checklist(s: SystemSnapshot): SetupItem[] {
    return buildChecklist({
      managed: s.helper.managed,
      helperExtensionId: s.helper.extensionId,
      extensionId: chrome.runtime.id,
      reviews: s.reviews,
      promptsFileExists: s.setup.promptsFileExists,
      repoRoots: s.setup.repoRoots,
      switchShortcut,
      workspaceCount: s.sessions.length,
      statusHooks: s.setup.statusHooks,
      configProblems: s.setup.configProblems,
    });
  }

  function updatesCard(): HTMLElement {
    const check = plain(
      updates?.checking ? 'Checking…' : 'Check for updates',
      () => {
        updates = { status: updates?.status ?? null, error: null, checking: true, applied: false };
        send({ type: 'checkUpdates' });
        render();
      },
      'Fetches from the remote; nothing is changed',
    );
    check.disabled = updates?.checking === true;

    const children: Node[] = [];
    const { status, error } = updates ?? { status: null, error: null };
    if (updates?.applied) {
      const reload = plain('Reload extension', () => chrome.runtime.reload(), 'Finishes the update: the new panel code loads');
      children.push(
        el('p', 'Updated. The helper is restarting, so every terminal ends; reload the extension to load the new panel.', 'settings-note'),
        actions(reload),
      );
    } else if (error) {
      children.push(el('p', `Could not check: ${error}`, 'settings-note warn'), actions(check));
    } else if (status) {
      children.push(row('Running', `${status.current} on ${status.branch}${status.upstream ? ` (tracks ${status.upstream})` : ''}`));
      if (status.release) children.push(row('Latest release', status.release));
      if (status.behind === 0) children.push(el('p', status.reason ?? 'Already up to date.', 'settings-note'));
      else {
        children.push(row('Available', `${status.behind} new commit${status.behind === 1 ? '' : 's'}`));
        const list = el('div', '', 'update-commits');
        list.append(...status.commits.map((c) => el('div', `${c.short}  ${c.subject}`, 'update-commit')));
        if (status.behind > status.commits.length) list.append(el('div', `…and ${status.behind - status.commits.length} more`, 'update-commit more'));
        children.push(list);
        if (!status.canUpdate && status.reason) children.push(el('p', status.reason, 'settings-note warn'));
      }
      const apply = guarded(
        'apply-update',
        'Update now',
        'Update, rebuild and restart?',
        () => {
          updates = { status, error: null, checking: false, applied: true };
          request({ action: 'applyUpdate' });
          render();
        },
        { disabled: status.canUpdate ? undefined : (status.reason ?? 'Nothing to update.') },
      );
      children.push(actions(check, ...(status.behind > 0 ? [apply] : [])));
    } else {
      children.push(
        el(
          'p',
          'Checks this copy of the app against the newest release. It only ever fast-forwards, never over uncommitted changes, then installs dependencies if they changed, rebuilds the extension and restarts the helper.',
          'settings-note',
        ),
        actions(check),
      );
    }
    return card('Updates', ...children);
  }

  function setUsageRange(usageRange: Prefs['usageRange']): void {
    prefs = { ...prefs, usageRange };
    void savePrefs({ usageRange });
    render();
  }

  function setupCard(s: SystemSnapshot): HTMLElement | null {
    const items = checklist(s);
    const open = remaining(items);
    if (open === 0 || prefs.setupDismissed) return null;
    const rows = items.map((item) => {
      const line = el('div', '', `setup-row${item.ok ? ' done' : ''}`);
      line.append(el('span', item.ok ? '✓' : '○', 'setup-mark'));
      const text = el('span', '', 'setup-text');
      text.append(el('span', item.label, 'setup-label'));
      if (!item.ok) text.append(el('span', `${item.detail} ${item.fix ?? ''}`.trim(), 'setup-detail'));
      line.append(text);
      return line;
    });
    const dismiss = plain(
      'Dismiss',
      () => {
        prefs = { ...prefs, setupDismissed: true };
        void savePrefs({ setupDismissed: true });
        render();
      },
      'Hide this checklist; the same checks stay in Diagnostics',
    );
    return card(`Getting started · ${items.length - open} of ${items.length} done`, ...rows, actions(dismiss));
  }

  function warningsCard(s: SystemSnapshot): HTMLElement | null {
    if (s.warnings.length === 0) return null;
    const rows = s.warnings.map((warning) => {
      const line = el('div', '', 'warning-row');
      line.append(el('span', '⚠', 'warning-mark'), el('span', warning.message, 'warning-text'));
      // A forgotten server can be stopped from here, with the same confirm as in the process list.
      if (warning.kind === 'idle-server' && warning.pid !== undefined) {
        const pid = warning.pid;
        line.append(guarded(`warn-stop-${pid}`, 'Stop it', 'Stop it?', () => request({ action: 'killProcess', id: warning.id, pid })));
      }
      return line;
    });
    return card(
      `Needs attention · ${s.warnings.length}`,
      ...rows,
      el(
        'p',
        `Limits: ${s.config.limits.memoryWarnMb} MB per workspace, servers idle over ${s.config.limits.idleServerHours} h. Change them under "limits" in the config.`,
        'settings-note',
      ),
    );
  }

  function choice<T extends string>(label: string, values: readonly T[], current: T, onChange: (value: T) => void): HTMLElement {
    const wrapper = el('label', '', 'pref');
    const select = el('select', '', 'pref-select');
    select.append(...values.map((value) => Object.assign(el('option', value[0].toUpperCase() + value.slice(1)), { value, selected: value === current })));
    select.addEventListener('change', () => onChange(select.value as T));
    wrapper.append(el('span', label, 'pref-label'), select);
    return wrapper;
  }

  function preferencesCard(): HTMLElement {
    return card(
      'Preferences',
      choice('Theme', THEMES, prefs.theme, (theme) => {
        prefs = { ...prefs, theme };
        void savePrefs({ theme });
      }),
      choice('Density', DENSITIES, prefs.density, (density) => {
        prefs = { ...prefs, density };
        void savePrefs({ density });
      }),
      checkbox(
        'Desktop notifications',
        prefs.notify,
        (notify) => {
          prefs = { ...prefs, notify };
          void savePrefs({ notify });
        },
        'When a workspace starts waiting for input or finishes. The toolbar icon always shows how many are waiting.',
      ),
    );
  }

  function render(): void {
    const scroll = body.scrollTop;
    updatedEl.textContent = snapshot ? `updated ${new Date(snapshot.takenAt).toLocaleTimeString()}` : '';
    if (!snapshot) {
      grid.replaceChildren(el('div', error ? `Could not read the system: ${error}` : 'Loading…', 'settings-empty'));
      return;
    }
    const cards = [
      ...[setupCard(snapshot), warningsCard(snapshot)].filter((card): card is HTMLElement => card !== null),
      planCard(snapshot),
      usageCard(snapshot, prefs.usageRange, setUsageRange),
      preferencesCard(),
      sessionsCard(snapshot),
      updatesCard(),
      helperCard(snapshot),
      housekeepingCard(snapshot),
      configCard(snapshot),
      diagnosticsCard(snapshot),
    ];
    // Detaching a focused dropdown closes it, so its card stays put, a poll behind, until focus leaves.
    const active = document.activeElement;
    const held = active instanceof HTMLSelectElement && grid.contains(active) ? active.closest<HTMLElement>('.settings-card') : null;
    const at = held ? cards.findIndex((card) => card.dataset.key === held.dataset.key) : -1;
    if (held && at >= 0) {
      for (const child of [...grid.children]) if (child !== held) child.remove();
      held.before(...cards.slice(0, at));
      held.after(...cards.slice(at + 1));
    } else {
      grid.replaceChildren(...cards);
    }
    body.scrollTop = scroll;
  }

  function showResult({ ok, message }: { ok: boolean; message: string }): void {
    resultEl.hidden = false;
    resultEl.className = ok ? 'ok' : 'bad';
    resultEl.textContent = message;
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => (resultEl.hidden = true), 8000);
  }

  function poll(): void {
    send({ type: 'system' });
    // An open activity list stays current while the view is showing.
    for (const id of activityOpen) send({ type: 'timeline', id });
    if (logText !== null) send({ type: 'systemLog' });
  }

  function show(): void {
    isOpen = true;
    section.hidden = false;
    resultEl.hidden = true;
    render();
    poll();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
    onToggle();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    section.hidden = true;
    clearInterval(pollTimer);
    onToggle();
  }

  $<HTMLButtonElement>('settings-close').addEventListener('click', close);
  $<HTMLButtonElement>('settings-refresh').addEventListener('click', poll);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) close();
  });

  return {
    get isOpen() {
      return isOpen;
    },
    show,
    close,
    setUpdates(message) {
      updates = { status: message.status, error: message.error, checking: false, applied: false };
      if (isOpen) render();
    },
    setTimeline(message) {
      activity.set(message.id, { events: message.events, error: message.error });
      if (isOpen) render();
    },
    get setupRemaining() {
      return snapshot && !prefs.setupDismissed ? remaining(checklist(snapshot)) : 0;
    },
    get warningCount() {
      return snapshot?.warnings.length ?? 0;
    },
    setSystem(message) {
      snapshot = message.snapshot ?? snapshot;
      void readShortcut();
      error = message.error;
      if (isOpen) render();
    },
    setResult(message) {
      showResult(message);
      if (isOpen) poll();
    },
    setLog(text) {
      if (logText === null) return;
      logText = text || '(empty)';
      if (isOpen) render();
    },
    download(json) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      link.download = `chrome-workspaces-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    },
  };
}
