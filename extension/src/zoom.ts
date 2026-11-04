/**
 * Chrome does not zoom a side panel with the page: Ctrl +/- and the zoom menu change only the tab. This
 * follows the zoom of the window's active tab and applies it to the panel, terminals included.
 */
export function followTabZoom(windowId: number): void {
  const apply = (factor: number) => {
    document.documentElement.style.zoom = String(factor);
  };
  const refresh = async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id !== undefined) apply(await chrome.tabs.getZoom(tab.id));
  };
  chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && void refresh());
  chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
    void chrome.tabs.query({ active: true, windowId }).then(([tab]) => tab?.id === tabId && apply(newZoomFactor));
  });
  void refresh();
}
