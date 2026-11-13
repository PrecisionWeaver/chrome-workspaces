// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAction, ControlToHelper } from '../../../shared/protocol/protocol';
import { createArming, el } from '../ui/dom';
import { actions, card, guarded, mono, plain, row, type SettingsContext, shortId } from './settings-parts';

const ARM_MS = 4000;

/** A context that records what a card asked of the view. */
function fakeContext() {
  const sent: ControlToHelper[] = [];
  const requests: AdminAction[] = [];
  const results: { ok: boolean; message: string }[] = [];
  let renders = 0;
  const ctx: SettingsContext = {
    send: (message) => (sent.push(message), true),
    request: (action) => void requests.push(action),
    render: () => void renders++,
    showResult: (result) => void results.push(result),
    arming: createArming(() => void renders++, ARM_MS),
  };
  return { ctx, sent, requests, results, renders: () => renders };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('row', () => {
  it('puts the label and a text value side by side, with a title for the whole line', () => {
    const line = row('Port', '4000', 'Where the helper listens');
    expect(line.className).toBe('kv');
    expect(line.title).toBe('Where the helper listens');
    expect(line.querySelector('.k')!.textContent).toBe('Port');
    expect(line.querySelector('.v')!.textContent).toBe('4000');
  });

  it('takes a node as the value, so a value can carry its own class', () => {
    const line = row('Status', el('span', 'Running', 'ok'));
    expect(line.querySelector('.v .ok')!.textContent).toBe('Running');
    expect(line.title).toBe('');
  });
});

describe('card', () => {
  it('is a section headed by its title, with the children after it', () => {
    const node = card('Helper', el('p', 'one'), el('p', 'two'));
    expect(node.tagName).toBe('SECTION');
    expect(node.className).toBe('settings-card');
    expect([...node.children].map((c) => c.textContent)).toEqual(['Helper', 'one', 'two']);
    expect(node.querySelector('h3')!.textContent).toBe('Helper');
  });

  it('keys itself by the title before the count, so a card is the same card from poll to poll', () => {
    expect(card('Workspaces · 2 running · 1.2K tokens').dataset.key).toBe('Workspaces');
    expect(card('Needs attention · 3').dataset.key).toBe('Needs attention');
    expect(card('Usage').dataset.key).toBe('Usage');
  });
});

describe('actions and mono', () => {
  it('groups buttons in a row', () => {
    const group = actions(el('button', 'a'), el('button', 'b'));
    expect(group.className).toBe('settings-actions');
    expect([...group.children].map((c) => c.textContent)).toEqual(['a', 'b']);
  });

  it('sets text in the monospace face', () => {
    expect(mono('/Users/me').className).toBe('mono');
    expect(mono('/Users/me').textContent).toBe('/Users/me');
  });
});

describe('guarded', () => {
  it('asks on the first click and runs on the second, redrawing after each', () => {
    const { ctx, renders } = fakeContext();
    const run = vi.fn();
    const button = guarded(ctx, 'stop', 'Stop', 'Stop it?', run);
    expect(button.type).toBe('button');
    expect(button.textContent).toBe('Stop');
    expect(button.classList.contains('armed')).toBe(false);

    button.click();
    expect(run).not.toHaveBeenCalled();
    expect(renders()).toBe(1);
    expect(ctx.arming.isArmed('stop')).toBe(true);

    button.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(renders()).toBe(2);
    expect(ctx.arming.isArmed('stop')).toBe(false);
  });

  it('shows the confirming label when drawn while armed, as a redraw between the clicks does', () => {
    const { ctx } = fakeContext();
    guarded(ctx, 'stop', 'Stop', 'Stop it?', () => {}).click();
    const redrawn = guarded(ctx, 'stop', 'Stop', 'Stop it?', () => {});
    expect(redrawn.textContent).toBe('Stop it?');
    expect(redrawn.classList.contains('armed')).toBe(true);
  });

  it('disarms by itself after four seconds, so a forgotten first click does not linger', () => {
    const { ctx, renders } = fakeContext();
    const run = vi.fn();
    const button = guarded(ctx, 'stop', 'Stop', 'Stop it?', run);
    button.click();
    vi.advanceTimersByTime(ARM_MS);
    expect(ctx.arming.isArmed('stop')).toBe(false);
    expect(renders()).toBe(2);
    button.click();
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps keys apart, so arming one button does not confirm another', () => {
    const { ctx } = fakeContext();
    const stop = vi.fn();
    const kill = vi.fn();
    guarded(ctx, 'stop', 'Stop', 'Stop it?', stop).click();
    guarded(ctx, 'kill', 'Force', 'Force kill?', kill).click();
    expect(stop).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(ctx.arming.isArmed('stop')).toBe(true);
    expect(ctx.arming.isArmed('kill')).toBe(true);
  });

  it('marks a dangerous action, and a disabled one with the reason as its title', () => {
    const { ctx } = fakeContext();
    const run = vi.fn();
    const danger = guarded(ctx, 'kill', 'Force', 'Force kill?', run, { danger: true });
    expect(danger.className).toBe('settings-btn danger');
    expect(danger.disabled).toBe(false);

    const off = guarded(ctx, 'restart', 'Restart helper', 'Restart?', run, { disabled: 'Started by hand' });
    expect(off.disabled).toBe(true);
    expect(off.title).toBe('Started by hand');
    expect(off.className).toBe('settings-btn');
  });
});

describe('plain', () => {
  it('runs at one click, with a title saying what it does', () => {
    const run = vi.fn();
    const button = plain('Refresh reviews', run, 'Fetches now');
    expect(button.type).toBe('button');
    expect(button.className).toBe('settings-btn');
    expect(button.title).toBe('Fetches now');
    button.click();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('shortId', () => {
  it('cuts a claude session id to its first group', () => {
    expect(shortId('0b7c1b4a-1234-4abc-8def-0123456789ab')).toBe('0b7c1b4a');
    expect(shortId('plain')).toBe('plain');
  });
});
