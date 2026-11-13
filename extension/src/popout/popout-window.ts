import { findPopout, popoutUrl } from '../../../shared/workspaces/popout';

/** Opens the workspace's terminal in its own window, or brings forward the one already showing it. */
export async function openPopout(workspaceId: string): Promise<void> {
  const base = chrome.runtime.getURL('');
  const existing = findPopout(await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] }), base, workspaceId);
  if (existing?.id !== undefined) {
    await chrome.windows.update(existing.id, { focused: true, drawAttention: true });
    return;
  }
  await chrome.windows.create({ type: 'popup', url: popoutUrl(base, workspaceId), width: 900, height: 600 });
}
