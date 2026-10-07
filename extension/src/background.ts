chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.commands.onCommand.addListener((command) => {
  // Lets the panel show which shortcut fired (spike risk 3). No open panel is fine.
  chrome.runtime.sendMessage({ type: 'command', command }).catch(() => {});
  if (command === 'next-workspace') void cycleWindows(1);
  if (command === 'prev-workspace') void cycleWindows(-1);
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
  await chrome.windows.update(to.id, {
    focused: true,
    left: from.left,
    top: from.top,
    width: from.width,
    height: from.height,
  });
}
