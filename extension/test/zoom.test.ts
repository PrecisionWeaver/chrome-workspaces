// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { followTabZoom } from '../src/zoom';
import { installChrome } from './chrome-mock';

let fake: ReturnType<typeof installChrome>;
const flush = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  fake = installChrome();
  document.documentElement.style.zoom = '';
});

describe('followTabZoom', () => {
  it('applies the active tab’s zoom, and follows changes to it', async () => {
    const tab = await fake.mock.tabs.create({ url: 'https://acme.test/' });
    fake.mock.tabs.getZoom.mockResolvedValue(1.25);
    followTabZoom(tab.windowId);
    await flush();
    expect(document.documentElement.style.zoom).toBe('1.25');
    fake.events.tabs.onZoomChange.emit({ tabId: tab.id!, newZoomFactor: 1.5 } as chrome.tabs.OnZoomChangeInfo);
    await flush();
    expect(document.documentElement.style.zoom).toBe('1.5');
  });

  it('ignores zoom changes in tabs that are not showing', async () => {
    const tab = await fake.mock.tabs.create({ url: 'https://acme.test/' });
    followTabZoom(tab.windowId);
    await flush();
    fake.events.tabs.onZoomChange.emit({ tabId: tab.id! + 99, newZoomFactor: 2 } as chrome.tabs.OnZoomChangeInfo);
    await flush();
    expect(document.documentElement.style.zoom).toBe('1');
  });
});
