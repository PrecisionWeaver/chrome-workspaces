import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { TokenTotals } from '../../shared/protocol';
import { localDayAndHour } from '../../shared/usage';

const CHUNK_BYTES = 4 * 1024 * 1024;

/** One assistant message's usage, with the model that produced it and the day and hour it was written, in the local time zone. */
interface Counted {
  usage: TokenTotals;
  model: string;
  day: string;
  /** 0 to 23, or null when the line had no usable timestamp. */
  hour: number | null;
}

/** Usage split by model, day and hour, e.g. for pricing and a trend. */
export interface UsageBucket {
  model: string;
  day: string;
  hour: number | null;
  usage: TokenTotals;
}

interface Tracked {
  offset: number;
  carry: string;
  decoder: StringDecoder;
  /** Each assistant message's usage once: claude writes a message several times as it streams. */
  byMessage: Map<string, Counted>;
  totals: TokenTotals;
  /** Whether the whole file has been counted at least once. */
  counted: boolean;
  /** The last scan could not read the file. */
  failed: boolean;
  scanning: Promise<void> | null;
}

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/** Messages grouped by model, day and hour, which is all that pricing and a trend need. */
function bucketsOf(messages: ReadonlyMap<string, Counted>): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const { model, day, hour, usage } of messages.values()) {
    const key = `${model}|${day}|${hour}`;
    const bucket = buckets.get(key) ?? { model, day, hour, usage: zero() };
    bucket.usage.input += usage.input;
    bucket.usage.output += usage.output;
    bucket.usage.cacheWrite += usage.cacheWrite;
    bucket.usage.cacheRead += usage.cacheRead;
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

interface UsageLine {
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
}

/** The usage a transcript line carries, with the id of the message it belongs to; null for any other line. */
export function usageFromLine(line: string): { id: string; usage: TokenTotals; model: string; day: string; hour: number | null } | null {
  // Most lines carry none, and parsing every line of a large transcript is the cost to avoid.
  if (!line.includes('"usage"')) return null;
  let parsed: UsageLine;
  try {
    parsed = JSON.parse(line) as UsageLine;
  } catch {
    return null;
  }
  const { id, usage, model } = parsed.message ?? {};
  const when = localDayAndHour(parsed.timestamp);
  if (typeof id !== 'string' || !usage) return null;
  const n = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    id,
    usage: {
      input: n(usage.input_tokens),
      output: n(usage.output_tokens),
      cacheWrite: n(usage.cache_creation_input_tokens),
      cacheRead: n(usage.cache_read_input_tokens),
    },
    model: typeof model === 'string' ? model : '',
    ...(when ? { day: when.day, hour: when.hour } : { day: '', hour: null }),
  };
}

/**
 * Adds up the tokens a claude session has used, from its transcript. A transcript is read once and then
 * only its new end, in the background, so asking is always quick: `peek` gives what is counted so far.
 */
export class TranscriptTokens {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly chunkBytes = CHUNK_BYTES) {}

  /** What has been counted so far, and whether the first full read is still running; null if the file was never asked about. */
  peek(path: string): { totals: TokenTotals; scanning: boolean; buckets: UsageBucket[] } | null {
    const t = this.tracked.get(path);
    // A transcript that cannot be read, and has never been counted, has no figure to show.
    if (!t || (t.failed && t.byMessage.size === 0)) return null;
    return { totals: { ...t.totals }, scanning: !t.counted, buckets: bucketsOf(t.byMessage) };
  }

  /** Counts what was appended since the last scan; resolves when it is up to date. */
  refresh(path: string): Promise<void> {
    let t = this.tracked.get(path);
    if (!t) {
      t = { offset: 0, carry: '', decoder: new StringDecoder('utf8'), byMessage: new Map(), totals: zero(), counted: false, failed: false, scanning: null };
      this.tracked.set(path, t);
    }
    const current = t;
    current.scanning ??= this.scan(path, current)
      .then(
        () => {
          current.failed = false;
        },
        () => {
          // A transcript that cannot be read keeps what was counted.
          current.failed = true;
        },
      )
      .finally(() => {
        current.counted = true;
        current.scanning = null;
      });
    return current.scanning;
  }

  /** Stops tracking transcripts that are no longer asked about. */
  keepOnly(paths: Iterable<string>): void {
    const keep = new Set(paths);
    for (const path of this.tracked.keys()) if (!keep.has(path)) this.tracked.delete(path);
  }

  private async scan(path: string, t: Tracked): Promise<void> {
    const { size } = await stat(path);
    if (size < t.offset) {
      // Rewritten, so start over.
      t.offset = 0;
      t.carry = '';
      t.decoder = new StringDecoder('utf8');
      t.byMessage.clear();
    }
    if (size === t.offset) return;
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(this.chunkBytes);
      while (t.offset < size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - t.offset), t.offset);
        if (bytesRead === 0) break;
        t.offset += bytesRead;
        const lines = (t.carry + t.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        t.carry = lines.pop() ?? '';
        for (const line of lines) {
          const found = usageFromLine(line);
          if (!found) continue;
          const seen = t.byMessage.get(found.id);
          // A message repeated while streaming grows; the largest of each figure is its final usage.
          t.byMessage.set(found.id, {
            model: found.model || seen?.model || '',
            // The day and hour come from the same line, so an hour is never paired with another line's day.
            day: found.day || seen?.day || '',
            hour: found.day ? found.hour : (seen?.hour ?? null),
            usage: seen
              ? {
                  input: Math.max(seen.usage.input, found.usage.input),
                  output: Math.max(seen.usage.output, found.usage.output),
                  cacheWrite: Math.max(seen.usage.cacheWrite, found.usage.cacheWrite),
                  cacheRead: Math.max(seen.usage.cacheRead, found.usage.cacheRead),
                }
              : found.usage,
          });
        }
      }
    } finally {
      await file.close();
    }
    const totals = zero();
    for (const { usage: u } of t.byMessage.values()) {
      totals.input += u.input;
      totals.output += u.output;
      totals.cacheWrite += u.cacheWrite;
      totals.cacheRead += u.cacheRead;
    }
    t.totals = totals;
  }
}
