import type { ControlToClient, ControlToHelper } from '../../../shared/protocol/protocol';
import type { SystemSnapshot } from '../../../shared/protocol/system';
import { $, createArming, el, wireBack } from '../ui/dom';
import { keepFocus } from '../ui/focus';
import { type CardLayout, columnCountFor, keysOf, layoutCards, layoutFromKeys, placeCards } from './settings-layout';
import { configCard, dataCard } from './settings-data';
import { type ConfigEditor, createConfigEditor } from './settings-config-edit';
import type { PrefsHandle, SettingsContext } from './settings-parts';
import { setupCard, setupChecklist, shownWarnings, warningsCard } from './settings-attention';
import { preferencesCard } from './settings-preferences';
import { helperCard, type HelperState, newHelperState } from './settings-helper';
import { newSessionsState, type SessionsState, workspacesCard } from './settings-sessions';
import { planCard, usageCard } from './settings-usage';
import { warningKey } from '../../../shared/usage/guardrails';
import { remaining } from '../../../shared/workspaces/onboarding';
import { loadPrefs, normalizePrefs, savePrefs, type Prefs } from '../app/prefs';

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
  /** How many warnings the last snapshot had that are not dismissed, for a marker on the settings button. */
  readonly warningCount: number;
  /** How many setup steps are still open, 0 once everything is done or the checklist is dismissed. */
  readonly setupRemaining: number;
  setTimeline(message: Extract<ControlToClient, { type: 'timeline' }>): void;
  setUpdates(message: Extract<ControlToClient, { type: 'updates' }>): void;
  setResult(message: Extract<ControlToClient, { type: 'adminResult' }>): void;
  setConfigEdit(message: Extract<ControlToClient, { type: 'configEdit' }>): void;
  setConfigSaved(message: Extract<ControlToClient, { type: 'configSaved' }>): void;
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
  const prefsHandle: PrefsHandle = {
    get: () => prefs,
    set(change) {
      prefs = { ...prefs, ...change };
      void savePrefs(change);
    },
  };
  const configEditor: ConfigEditor = createConfigEditor({ host: section, cards: body, send, showResult: (result) => showResult(result) });
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

  function setUsageRange(usageRange: Prefs['usageRange']): void {
    prefs = { ...prefs, usageRange };
    void savePrefs({ usageRange });
    render();
  }

  // A button waiting for its second press keeps keyboard focus through the redraw.
  const place = (layout: CardLayout, held: HTMLElement | null): void => keepFocus(grid, () => placeCards(grid, layout, held));

  function render(): void {
    const scroll = body.scrollTop;
    updatedEl.textContent = snapshot ? `updated ${new Date(snapshot.takenAt).toLocaleTimeString()}` : '';
    if (!snapshot) {
      grid.replaceChildren(el('div', error ? `Could not read the system: ${error}` : 'Loading…', 'settings-empty'));
      return;
    }
    const cards = [
      ...[setupCard(ctx, prefsHandle, switchShortcut, snapshot), warningsCard(ctx, prefsHandle, snapshot)].filter((card): card is HTMLElement => card !== null),
      planCard(snapshot),
      usageCard(snapshot, prefs.usageRange, setUsageRange),
      workspacesCard(ctx, sessions, snapshot),
      preferencesCard(prefsHandle, switchShortcut),
      helperCard(ctx, helper, snapshot),
      dataCard(ctx, snapshot),
      configCard(snapshot, () => configEditor.open(snapshot?.helper.configPath ?? '')),
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
    // Nobody is looking at a hidden panel; it asks again when it is shown.
    if (document.visibilityState !== 'visible') return;
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

  document.addEventListener('visibilitychange', () => {
    if (isOpen) poll();
  });

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    configEditor.close();
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
      return snapshot && !prefs.setupDismissed ? remaining(setupChecklist(snapshot, switchShortcut)) : 0;
    },
    get warningCount() {
      return snapshot ? shownWarnings(prefsHandle, snapshot).length : 0;
    },
    setSystem(message) {
      snapshot = message.snapshot ?? snapshot;
      // A dismissal lasts while its warning does, so the same trouble coming back later is shown again.
      // A server's lasts while the process does: a blip of CPU lifts its warning for a snapshot, and
      // that must not bring back one the user has dismissed.
      if (message.snapshot) {
        const current = new Set(message.snapshot.warnings.map(warningKey));
        for (const session of message.snapshot.sessions) {
          for (const proc of session.processes) current.add(warningKey({ kind: 'idle-server', id: session.id, pid: proc.pid }));
        }
        const dismissedWarnings = prefs.dismissedWarnings.filter((k) => current.has(k));
        if (dismissedWarnings.length !== prefs.dismissedWarnings.length) {
          prefs = { ...prefs, dismissedWarnings };
          void savePrefs({ dismissedWarnings });
        }
      }
      void readShortcut();
      error = message.error;
      if (isOpen) render();
    },
    setConfigEdit(message) {
      configEditor.setEdit(message);
    },
    setConfigSaved(message) {
      configEditor.setSaved(message);
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
