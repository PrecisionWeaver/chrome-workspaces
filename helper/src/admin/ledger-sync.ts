import { statSync } from 'node:fs';
import { localDay, localDayBack, USAGE_HISTORY_DAYS } from '../../../shared/usage/usage';
import { TranscriptTokens } from '../claude/tokens';
import type { UsageLedger } from '../claude/usage-ledger';

/** The workspace a transcript belongs to. */
export interface TranscriptOwner {
  id: string;
  name: string;
}

export interface LedgerSyncOptions {
  /** The workspaces whose current transcripts are live. */
  workspaces: () => readonly TranscriptOwner[];
  /** The transcript of the workspace's current claude session, for counting its tokens. */
  transcript: (id: string) => string | null;
  /** Archived workspaces whose session files are still kept, so a transcript the ledger has not yet counted is counted into it. */
  archived: () => readonly (TranscriptOwner & { transcript: string })[];
  /** Counts the live transcripts as they grow; anything else is counted once into the ledger and then read from there. */
  tokens: TranscriptTokens;
  ledger: UsageLedger;
}

export interface LedgerSync {
  /** Each workspace's current transcript, by path. */
  liveTranscripts(): Map<string, TranscriptOwner>;
  /** Puts a live transcript's figures in the ledger once it has been read to the end, so they outlast its session. */
  recordLive(transcript: string, owner: TranscriptOwner): void;
  /** When the conversations a transcript may have copied from ended, from the ledger; null when it cannot be read. */
  earlierEnded(transcript: string, workspaceId: string): number | null;
  /** Counts what a live transcript has grown by. */
  refreshLive(transcript: string, owner: { id: string }): Promise<void>;
  /**
   * Counts into the ledger every transcript that is no longer live and has been written to since it was last counted:
   * an archived workspace's, or one left behind by `/clear`, a restart or a fork. Each is read once by a counter of its
   * own, so none stays in memory. Then old days are dropped and the file is written. One pass runs at a time.
   */
  settle(): Promise<void>;
}

/** Keeps the usage ledger in step with the transcripts: live ones counted as they grow, every other one counted once. */
export function createLedgerSync({ workspaces, transcript, archived, tokens, ledger }: LedgerSyncOptions): LedgerSync {
  const liveTranscripts = () => {
    const live = new Map<string, TranscriptOwner>();
    for (const ws of workspaces()) {
      const path = transcript(ws.id);
      if (path) live.set(path, { id: ws.id, name: ws.name });
    }
    return live;
  };

  const save = (path: string, owner: TranscriptOwner, counted: NonNullable<ReturnType<TranscriptTokens['peek']>>) => {
    const { createdMs, mtimeMs, lastAt, buckets } = counted;
    ledger.record({ transcript: path, workspaceId: owner.id, name: owner.name, createdMs, mtimeMs, lastAt, buckets });
  };

  const recordLive = (path: string, owner: TranscriptOwner) => {
    const counted = tokens.peek(path);
    if (!counted || counted.scanning) return;
    save(path, owner, counted);
  };

  const earlierEnded = (path: string, workspaceId: string) => {
    try {
      return ledger.earlierEnded(workspaceId, statSync(path).birthtimeMs);
    } catch {
      return null;
    }
  };

  const refreshLive = (path: string, owner: { id: string }) => tokens.refresh(path, earlierEnded(path, owner.id));

  let settling: Promise<void> | null = null;
  const settle = (): Promise<void> => {
    settling ??= (async () => {
      const live = liveTranscripts();
      const pending = new Map<string, TranscriptOwner>();
      for (const entry of ledger.list()) {
        if (live.has(entry.transcript)) continue;
        try {
          if (statSync(entry.transcript).mtimeMs > entry.mtimeMs) pending.set(entry.transcript, { id: entry.workspaceId, name: entry.name });
        } catch {
          // Claude deleted it; the figures it left stay.
        }
      }
      for (const a of archived()) {
        if (!live.has(a.transcript) && !ledger.get(a.transcript)) pending.set(a.transcript, { id: a.id, name: a.name });
      }
      // Oldest first, so a fork is counted after the conversation it copied.
      const created = (path: string) => {
        try {
          return statSync(path).birthtimeMs;
        } catch {
          return 0;
        }
      };
      for (const [path, owner] of [...pending].sort(([a], [b]) => created(a) - created(b))) {
        const once = new TranscriptTokens();
        await once.refresh(path, earlierEnded(path, owner.id));
        const counted = once.peek(path);
        if (counted) save(path, owner, counted);
      }
      for (const [path, owner] of live) recordLive(path, owner);
      const now = new Date();
      ledger.prune(localDayBack(now, USAGE_HISTORY_DAYS - 1), localDay(now));
      ledger.save();
    })().finally(() => {
      settling = null;
    });
    return settling;
  };

  return { liveTranscripts, recordLive, earlierEnded, refreshLive, settle };
}
