import type { ResourceSample } from '../../shared/protocol';

/** How often a session is sampled, and how many samples are kept: two hours. */
export const SAMPLE_INTERVAL_MS = 60_000;
export const SAMPLE_COUNT = 120;

/** What each running session's shell tree has used lately, so Settings can draw a trend rather than a single reading. */
export class ResourceHistory {
  private readonly byId = new Map<string, ResourceSample[]>();

  record(id: string, sample: ResourceSample): void {
    const samples = this.byId.get(id) ?? [];
    samples.push(sample);
    if (samples.length > SAMPLE_COUNT) samples.splice(0, samples.length - SAMPLE_COUNT);
    this.byId.set(id, samples);
  }

  get(id: string): ResourceSample[] {
    return [...(this.byId.get(id) ?? [])];
  }

  /** Forgets any session not in `ids`, so one that stopped and starts again begins a fresh trend. */
  keepOnly(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of this.byId.keys()) if (!keep.has(id)) this.byId.delete(id);
  }
}
