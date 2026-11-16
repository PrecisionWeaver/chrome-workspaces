import type { SystemSnapshot } from '../../../shared/protocol/protocol';
import { warningKey } from '../../../shared/usage/guardrails';
import { buildChecklist, remaining, type SetupItem } from '../../../shared/workspaces/onboarding';
import { el } from '../ui/dom';
import { actions, card, guarded, plain, type PrefsHandle, type SettingsContext } from './settings-parts';

/** What setup still needs, from the snapshot and the shortcut Chrome has bound. */
export function setupChecklist(s: SystemSnapshot, switchShortcut: string): SetupItem[] {
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

/** The getting-started checklist; null once it is done or dismissed. */
export function setupCard(ctx: SettingsContext, prefs: PrefsHandle, switchShortcut: string, s: SystemSnapshot): HTMLElement | null {
  const items = setupChecklist(s, switchShortcut);
  const open = remaining(items);
  if (open === 0 || prefs.get().setupDismissed) return null;
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
      prefs.set({ setupDismissed: true });
      ctx.render();
    },
    'Hide this checklist; the Helper and Configuration cards keep saying what it checks',
  );
  return card(`Getting started · ${items.length - open} of ${items.length} done`, ...rows, actions(dismiss));
}

/** The warnings not dismissed. */
export const shownWarnings = (prefs: PrefsHandle, s: SystemSnapshot) => s.warnings.filter((w) => !prefs.get().dismissedWarnings.includes(warningKey(w)));

/** Warnings not dismissed; null when there are none. */
export function warningsCard(ctx: SettingsContext, prefs: PrefsHandle, s: SystemSnapshot): HTMLElement | null {
  const warnings = shownWarnings(prefs, s);
  if (warnings.length === 0) return null;
  const rows = warnings.map((warning) => {
    const line = el('div', '', 'warning-row');
    line.append(el('span', '⚠', 'warning-mark'), el('span', warning.message, 'warning-text'));
    // A forgotten server can be stopped from here, with the same confirm as in the process list.
    if (warning.kind === 'idle-server' && warning.pid !== undefined) {
      const pid = warning.pid;
      line.append(guarded(ctx, `warn-stop-${pid}`, 'Stop it', 'Stop it?', () => ctx.request({ action: 'killProcess', id: warning.id, pid })));
    }
    line.append(
      plain(
        'Dismiss',
        () => {
          prefs.set({ dismissedWarnings: [...prefs.get().dismissedWarnings, warningKey(warning)] });
          ctx.render();
        },
        'Hide this until it clears and comes back (a server: until it stops)',
      ),
    );
    return line;
  });
  return card(
    `Needs attention · ${warnings.length}`,
    ...rows,
    el(
      'p',
      `Limits: ${s.config.limits.memoryWarnMb} MB per workspace, servers idle over ${s.config.limits.idleServerHours} h. Change them under "limits" in the config.`,
      'settings-note',
    ),
  );
}
