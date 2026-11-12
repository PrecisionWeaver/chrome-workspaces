import type { ControlToClient, ControlToHelper, SystemSnapshot } from '../../shared/protocol';
import { $, createArming, el, wireBack } from './dom';
import { type CardLayout, columnCountFor, keysOf, layoutCards, layoutFromKeys } from './settings-layout';
import { actions, card, guarded, mono, plain, row, type SettingsContext } from './settings-parts';
import { helperCard, type HelperState, newHelperState } from './settings-helper';
import { newSessionsState, type SessionsState, workspacesCard } from './settings-sessions';
import { planCard, usageCard } from './settings-usage';
import { formatBytes } from './format';
import { DENSITIES, THEMES } from '../../shared/keynav';
import { buildChecklist, remaining, type SetupItem } from '../../shared/onboarding';
import { loadPrefs, normalizePrefs, savePrefs, type Prefs } from './prefs';

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
  let prefs: Prefs = normalizePrefs(undefined);
  // Read once per snapshot; the shortcut is a browser setting the helper cannot see.
  let switchShortcut = '';
  const readShortcut = () =>
    chrome.commands.getAll().then((commands) => {
      const bound = commands.find((c) => c.name === 'next-workspace')?.shortcut ?? '';
      if (bound === switchShortcut) return;
      switchShortcut = bound;
      if (isOpen) render();
    });
  void readShortcut();
  void loadPrefs().then((loaded) => {
    prefs = loaded;
    if (isOpen) render();
  });
  const sessions: SessionsState = newSessionsState();
  const helper: HelperState = newHelperState();

  const ctx: SettingsContext = {
    send,
    request: (action) => void send({ type: 'admin', request: action }),
    render: () => render(),
    showResult: (result) => showResult(result),
    arming: createArming(() => render(), ARM_MS),
  };

  // ---- sections ----

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

  function setUsageRange(usageRange: Prefs['usageRange']): void {
    prefs = { ...prefs, usageRange };
    void savePrefs({ usageRange });
    render();
  }

  function dataCard(s: SystemSnapshot): HTMLElement {
    return card(
      'Data',
      row('Uploads', formatBytes(s.storage.uploadsBytes), 'Files dropped or pasted into terminals; deleted after a week'),
      row('Helper log', formatBytes(s.storage.logBytes)),
      row('Data folder', formatBytes(s.storage.dataBytes)),
      actions(
        guarded(ctx, 'clear-uploads', 'Clear uploads', 'Delete all uploads?', () => ctx.request({ action: 'clearUploads' })),
        guarded(ctx, 'clear-log', 'Clear log', 'Empty the log?', () => ctx.request({ action: 'clearLog' })),
        plain(
          'Prune worktrees',
          () => ctx.request({ action: 'pruneWorktrees' }),
          "Removes git records of worktrees whose folders are gone, in each workspace's repository",
        ),
        plain('Export workspaces', () => send({ type: 'exportData' }), 'Downloads the workspace list as JSON'),
      ),
    );
  }

  function configCard(s: SystemSnapshot): HTMLElement {
    const { config, helper, setup } = s;
    const map = (record: Record<string, string>) =>
      Object.keys(record).length
        ? Object.entries(record)
            .map(([k, v]) => `${k} → ${v}`)
            .join('\n')
        : 'none';
    return card(
      'Configuration',
      el('p', `Read from ${helper.configPath}. Edit it and restart the helper to change these.`, 'settings-note'),
      ...(setup.configProblems.length ? [row('Ignored entries', el('span', setup.configProblems.join('\n'), 'bad'))] : []),
      row('Default directory', mono(config.defaultCwd)),
      row('Prompts file', mono(config.promptsFile)),
      row('Default model', config.defaultModel ?? "claude's own"),
      row('Command', config.claudeCommand),
      row('Claude arguments', mono(config.claudeArgs.join(' ') || 'none')),
      row('Team prompts', mono(config.promptsFiles.join('\n') || 'none')),
      row('Team templates', mono(config.templatesFile ?? 'none')),
      row('Repo folders', mono(config.repoRoots.join('\n') || 'none')),
      row('Repo directories', mono(map(config.repoDirs))),
      row('Watched repos', mono(config.watchRepos.join('\n') || 'none')),
      row('Jira', mono(config.jiraBaseUrl ?? 'none')),
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
      'Hide this checklist; the Helper and Configuration cards keep saying what it checks',
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
        line.append(guarded(ctx, `warn-stop-${pid}`, 'Stop it', 'Stop it?', () => ctx.request({ action: 'killProcess', id: warning.id, pid })));
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
    const change = plain(
      'Change',
      () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
      "Chrome's shortcuts page, where the keys are bound",
    );
    const shortcut = row('Switch workspaces', switchShortcut || 'not bound', 'The key that moves to the next workspace; the previous one is its mirror');
    shortcut.append(change);
    return card(
      'Preferences',
      shortcut,
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

  /** Puts the layout's groups in the grid; the held card is not moved, so its open dropdown survives. */
  function place(layout: CardLayout, held: HTMLElement | null): void {
    const groups = [
      ...(layout.top.length ? [{ cls: 'settings-top', cards: layout.top }] : []),
      ...layout.columns.map((c) => ({ cls: 'settings-column', cards: c })),
    ];
    const holder = held?.parentElement;
    const heldAt = held ? groups.findIndex((g) => g.cards.some((card) => card.dataset.key === held.dataset.key)) : -1;
    // The same layout as last time, so the held card can stay where it is; a different one has to move it.
    const same = holder != null && heldAt >= 0 && grid.children.length === groups.length && grid.children[heldAt] === holder;
    if (held && same) {
      groups.forEach((g, i) => {
        const node = grid.children[i] as HTMLElement;
        if (node !== holder) {
          node.replaceChildren(...g.cards);
          return;
        }
        const at = g.cards.findIndex((card) => card.dataset.key === held.dataset.key);
        for (const child of [...node.children]) if (child !== held) child.remove();
        held.before(...g.cards.slice(0, at));
        held.after(...g.cards.slice(at + 1));
      });
      return;
    }
    grid.replaceChildren(
      ...groups.map((g) => {
        const node = el('div', '', g.cls);
        node.append(...g.cards);
        return node;
      }),
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
      workspacesCard(ctx, sessions, snapshot),
      preferencesCard(),
      helperCard(ctx, helper, snapshot),
      dataCard(snapshot),
      configCard(snapshot),
    ];
    columnsNow = columnCountFor(body.clientWidth);
    // Where the cards were put last time stays put while the cards and columns are the same, so a refresh never shuffles them.
    const signature = `${columnsNow}|${snapshot.sessions.length}|${cards.map((card) => card.dataset.key).join(',')}`;
    const settled = placement?.signature === signature;
    const layout = settled && placement ? layoutFromKeys(cards, placement.keys) : layoutCards(cards, columnsNow);
    // Detaching a focused dropdown closes it, so its card stays put, a poll behind, until focus leaves.
    const active = document.activeElement;
    const held = active instanceof HTMLSelectElement && grid.contains(active) ? active.closest<HTMLElement>('.settings-card') : null;
    place(layout, held);
    if (!settled && columnsNow > 1 && !held) {
      // Heights are only known once the cards are laid out, so the first placement is a guess and this one evens the columns by them.
      const heights = new Map(cards.map((card) => [card, card.offsetHeight]));
      if ([...heights.values()].some((h) => h > 0)) {
        const balanced = layoutCards(cards, columnsNow, (card) => heights.get(card) ?? 0);
        placement = { signature, keys: keysOf(balanced) };
        place(balanced, null);
      }
    } else if (!settled && columnsNow > 1) {
      placement = null;
    }
    body.scrollTop = scroll;
    for (const list of grid.querySelectorAll<HTMLElement>('.procs[data-session]'))
      list.scrollTop = sessions.procScroll.get(list.dataset.session as string) ?? 0;
  }

  // Widening the panel adds a column, so the cards are dealt again when that changes, and not for every pixel.
  let columnsNow = 0;
  /** Where the cards went the last time they were evened out by height, for as long as the cards and columns stay the same. */
  let placement: { signature: string; keys: string[][] } | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      const count = columnCountFor(body.clientWidth);
      if (isOpen && snapshot && count !== columnsNow) render();
    }).observe(body);
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
    for (const id of sessions.activityOpen) send({ type: 'timeline', id });
    if (helper.logText !== null) send({ type: 'systemLog' });
  }

  function show(): void {
    isOpen = true;
    // Heights may have changed while it was closed, so the columns are evened out again.
    placement = null;
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

  wireBack('settings-close', close, () => isOpen);
  $<HTMLButtonElement>('settings-refresh').addEventListener('click', poll);

  return {
    get isOpen() {
      return isOpen;
    },
    show,
    close,
    setUpdates(message) {
      helper.updates = { status: message.status, error: message.error, checking: false, applied: false };
      if (isOpen) render();
    },
    setTimeline(message) {
      sessions.activity.set(message.id, { events: message.events, error: message.error });
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
      if (helper.logText === null) return;
      helper.logText = text || '(empty)';
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
