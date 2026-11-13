import { format } from 'node:util';

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `2026-01-02 03:04:05`, in local time: the log is read by whoever sits at this Mac. */
export function timestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

type Sink = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * Starts every line the helper logs with the time, and a warning or error with its level, so helper.log says when
 * something happened. A message of several lines is prefixed once, at its first line.
 */
export function stampConsole(sink: Sink = console, now: () => Date = () => new Date()): void {
  for (const level of ['log', 'warn', 'error'] as const) {
    const write = sink[level].bind(sink);
    const label = level === 'log' ? '' : ` ${level === 'warn' ? 'warning' : 'error'}:`;
    sink[level] = (...args: unknown[]) => write(`${timestamp(now())}${label} ${format(...args)}`);
  }
}
