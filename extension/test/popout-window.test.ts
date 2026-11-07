import { beforeEach, describe, expect, it } from 'vitest';
import { openPopout } from '../src/popout-window';
import { installChrome } from './chrome-mock';

let fake: ReturnType<typeof installChrome>;
beforeEach(() => {
  fake = installChrome();
});

const popoutTabs = async () => (await chrome.tabs.query({})).filter((tab) => tab.url?.includes('popout.html'));

describe('openPopout', () => {
  it('opens a popup window on the workspace', async () => {
    await openPopout('ws-one');
    expect(fake.mock.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup', url: 'chrome-extension://ext-id/popout.html?ws=ws-one' }));
    expect((await popoutTabs()).map((tab) => tab.url)).toEqual(['chrome-extension://ext-id/popout.html?ws=ws-one']);
  });

  it('brings forward the window already showing it instead of opening another', async () => {
    await openPopout('ws-one');
    await openPopout('ws-one');
    expect(fake.mock.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.windowUpdates).toEqual([{ focused: true, drawAttention: true }]);
  });

  it('opens a separate window for another workspace', async () => {
    await openPopout('ws-one');
    await openPopout('ws-two');
    expect(fake.mock.windows.create).toHaveBeenCalledTimes(2);
  });
});
