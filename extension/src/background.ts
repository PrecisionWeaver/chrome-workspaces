chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.commands.onCommand.addListener((command) => {
  // Lets the panel show which shortcut fired (spike risk 3). No open panel is fine.
  chrome.runtime.sendMessage({ type: 'command', command }).catch(() => {});
  if (command === 'next-workspace') void cycleWindows(1);
  if (command === 'prev-workspace') void cycleWindows(-1);
});

type Bounds = Pick<chrome.windows.Window, 'left' | 'top' | 'width' | 'height'>;
type SharedSize = { maximized: true } | Bounds;

// Whichever window the user last moved or resized sets the size every workspace shares.
// Stored rather than held in memory because the service worker can be stopped at any time.
chrome.windows.onBoundsChanged.addListener((window) => {
  if (window.type !== 'normal') return;
  let sharedSize: SharedSize;
  if (window.state === 'maximized') sharedSize = { maximized: true };
  else if (window.state === 'normal') sharedSize = { left: window.left, top: window.top, width: window.width, height: window.height };
  else return;
  void chrome.storage.local.set({ sharedSize });
});

// Spike only: every normal window counts as a workspace, ordered by id.
// The next plan replaces this with the workspace list.
async function cycleWindows(step: 1 | -1): Promise<void> {
  const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const current = windows.findIndex((w) => w.focused);
  if (windows.length < 2 || current === -1) return;

  const from = windows[current];
  const to = windows[(current + step + windows.length) % windows.length];
  if (to.id === undefined) return;

  const { sharedSize } = (await chrome.storage.local.get('sharedSize')) as { sharedSize?: SharedSize };
  const size = sharedSize ?? { left: from.left, top: from.top, width: from.width, height: from.height };
  if ('maximized' in size) await chrome.windows.update(to.id, { focused: true, state: 'maximized' });
  else await chrome.windows.update(to.id, { focused: true, state: 'normal', ...size });
}
