import { describe, expect, it } from 'vitest';
import { stampConsole, timestamp } from '../src/log';

describe('timestamp', () => {
  it('writes the local date and time, padded', () => {
    expect(timestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
  });
});

describe('stampConsole', () => {
  const capture = () => {
    const lines: string[] = [];
    const push = (...args: unknown[]) => void lines.push(args.join(' '));
    const sink = { log: push, warn: push, error: push };
    stampConsole(sink, () => new Date(2026, 0, 2, 3, 4, 5));
    return { sink, lines };
  };

  it('puts the time before a message, and the level before a warning or error', () => {
    const { sink, lines } = capture();
    sink.log('started');
    sink.warn('slow');
    sink.error('broke');
    expect(lines).toEqual(['2026-01-02 03:04:05 started', '2026-01-02 03:04:05 warning: slow', '2026-01-02 03:04:05 error: broke']);
  });

  it('joins several arguments into one line, as console would', () => {
    const { sink, lines } = capture();
    sink.log('ended', 3, 'terminals');
    expect(lines).toEqual(['2026-01-02 03:04:05 ended 3 terminals']);
  });
});
