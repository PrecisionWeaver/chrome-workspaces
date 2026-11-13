// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPanelHtml } from '../../testing/fixtures';
import { createNotices, INSTALL_COMMAND, type Notices } from './notices';

const startHelper = vi.fn(async () => {});
const getHelper = vi.fn(async (): Promise<unknown> => ({ token: 't', port: 1 }));
vi.mock('../app/helper-client', () => ({
  startHelper: () => startHelper(),
  getHelper: () => getHelper(),
  isHostMissing: (error: unknown) => /native messaging host not found/i.test(String(error)),
}));

let notices: Notices;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const notice = () => $<HTMLDivElement>('notice');
const action = () => notice().querySelector<HTMLButtonElement>('.notice-action')!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  loadPanelHtml();
  startHelper.mockReset();
  startHelper.mockResolvedValue(undefined);
  getHelper.mockReset();
  getHelper.mockResolvedValue({ token: 't', port: 1 });
  notices = createNotices();
});
afterEach(() => vi.unstubAllGlobals());

describe('a plain notice', () => {
  it('shows the text, and hides the bar for null', () => {
    notices.show('Could not add big.bin: too large');
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toBe('Could not add big.bin: too large');
    notices.show(null);
    expect(notice().hidden).toBe(true);
    expect(notice().textContent).toBe('');
  });
});

describe('the helper offline', () => {
  it('says the helper is not running, with a button to start it', () => {
    notices.showOffline();
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toContain('Helper not running.');
    action().click();
    expect(startHelper).toHaveBeenCalled();
    expect(notice().textContent).toContain('Starting the helper…');
    expect(action().disabled).toBe(true);
  });

  it('says why starting failed and lets it be tried again', async () => {
    startHelper.mockRejectedValue(new Error('not installed'));
    notices.showOffline();
    action().click();
    await flush();
    expect(notice().textContent).toContain('Could not start the helper: not installed. Try npm run agent:start.');
    expect(action().disabled).toBe(false);
  });

  it('tells a missing native host to run the installer instead of offering to start it', async () => {
    getHelper.mockRejectedValueOnce(new Error('Specified native messaging host not found.'));
    notices.showOffline();
    await flush();
    expect(notice().textContent).toContain('The helper is not installed.');
    expect(notice().textContent).toContain(INSTALL_COMMAND);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    action().click();
    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
    expect(action().textContent).toBe('Copied');
  });

  it('leaves a notice that has since been replaced alone when the host check comes back', async () => {
    getHelper.mockRejectedValueOnce(new Error('Specified native messaging host not found.'));
    notices.showOffline();
    notices.show('Something else');
    await flush();
    expect(notice().textContent).toBe('Something else');
  });

  it('points to the installer when starting fails because the native host is missing', async () => {
    startHelper.mockRejectedValue(new Error('Specified native messaging host not found.'));
    notices.showOffline();
    action().click();
    await flush();
    expect(notice().textContent).toContain('The helper is not installed.');
  });
});
