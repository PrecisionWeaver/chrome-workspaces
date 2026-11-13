import { existsSync } from 'node:fs';
import type { ReviewsState, SystemSnapshot, UsageWorkspace } from '../../../shared/protocol/protocol';
import { findWarnings } from '../../../shared/usage/guardrails';
import { costOf, isRealModel, rateFor } from '../../../shared/usage/pricing';
import { localDay } from '../../../shared/usage/usage';
import type { TranscriptTokens, UsageBucket } from '../claude/tokens';
import type { UsageLedger } from '../claude/usage-ledger';
import { pathBytes, type Proc, readListening, subtree, toSystemProcess } from '../platform/system';
import type { ResourceHistory } from '../store/resource-history';
import type { AdminOptions } from './admin';
import type { LedgerSync } from './ledger-sync';
import { type DayTotals, emptyDay, mergeWorkspaces, usageByHour, usageTrend } from './usage-stats';

/** What a snapshot is built from: the service's options, and the counters it keeps from one snapshot to the next. */
export interface SnapshotContext {
  options: AdminOptions;
  readProcs: () => Promise<Proc[]>;
  /** Live transcripts only: anything else is counted once into the ledger and then read from there. */
  tokens: TranscriptTokens;
  ledger: UsageLedger;
  history: ResourceHistory;
  sync: LedgerSync;
}

/** The Settings snapshot: the helper, each workspace's session and processes, usage and cost, warnings, storage and config. */
export async function buildSnapshot(context: SnapshotContext, extra: { reviews: ReviewsState; clients: number }): Promise<SystemSnapshot> {
  const { options, readProcs, tokens, ledger, history, sync } = context;
  const { sessions, store, config, paths } = options;
  const { reviews, clients } = extra;
  const [procs, listening, managed] = await Promise.all([readProcs(), readListening(), options.isManaged()]);
  const snapshotSessions = store.list();
  // A live transcript is counted as it grows; every other one comes from the ledger, so none is counted twice.
  const live = sync.liveTranscripts();
  tokens.keepOnly(live.keys());
  void sync.settle().catch(() => {});
  // Every counted transcript's usage by model and day, for the trend across workspaces.
  const dayTotals = new Map<string, DayTotals>();
  const today = localDay(new Date());
  const hourTotals = new Map<number, { tokens: number; costUsd: number }>();
  const workspaceUsage: UsageWorkspace[] = [];
  let counting = false;
  const unpriced = new Set<string>();
  /** Adds usage to the trend and to its workspace's row; returns what it cost. */
  const addUsage = (id: string, name: string, buckets: readonly UsageBucket[]) => {
    let costUsd = 0;
    const ownDays = new Map<string, { tokens: number; costUsd: number }>();
    for (const bucket of buckets) {
      const cost = costOf(bucket.usage, bucket.model, config.pricing);
      if (isRealModel(bucket.model) && !rateFor(bucket.model, config.pricing)) unpriced.add(bucket.model);
      costUsd += cost;
      if (bucket.day) {
        const day = dayTotals.get(bucket.day) ?? emptyDay();
        // New work only, as everywhere else: cache reads repeat earlier input.
        const tokens = bucket.usage.input + bucket.usage.output + bucket.usage.cacheWrite;
        day.tokens += tokens;
        day.costUsd += cost;
        day.output += bucket.usage.output;
        day.cacheRead += bucket.usage.cacheRead;
        if (isRealModel(bucket.model)) {
          const model = day.models.get(bucket.model) ?? { tokens: 0, costUsd: 0 };
          model.tokens += tokens;
          model.costUsd += cost;
          day.models.set(bucket.model, model);
        }
        dayTotals.set(bucket.day, day);
        const own = ownDays.get(bucket.day) ?? { tokens: 0, costUsd: 0 };
        own.tokens += tokens;
        own.costUsd += cost;
        ownDays.set(bucket.day, own);
        if (bucket.day === today && bucket.hour !== null) {
          const hour = hourTotals.get(bucket.hour) ?? { tokens: 0, costUsd: 0 };
          hour.tokens += tokens;
          hour.costUsd += cost;
          hourTotals.set(bucket.hour, hour);
        }
      }
    }
    if (ownDays.size) {
      const daily = [...ownDays].map(([day, used]) => ({ day, ...used })).sort((a, b) => a.day.localeCompare(b.day));
      workspaceUsage.push({ id, name, daily });
    }
    return costUsd;
  };
  /** A live transcript's usage, from the ledger until a first count after a restart has caught up with it. */
  const countUsage = (id: string, name: string, transcript: string | null) => {
    if (!transcript) return { counted: null, costUsd: 0 };
    // Counting a large transcript the first time takes a while, so it runs behind the answer.
    void sync.refreshLive(transcript, { id });
    const counted = tokens.peek(transcript);
    sync.recordLive(transcript, { id, name });
    const saved = ledger.get(transcript);
    if ((!counted || counted.scanning) && saved) return { counted, costUsd: addUsage(id, name, saved.buckets) };
    if (counted?.scanning) counting = true;
    return { counted, costUsd: addUsage(id, name, counted?.buckets ?? []) };
  };
  const sessionRows = snapshotSessions.map((ws) => {
    const pid = sessions.get(ws.id)?.pid ?? null;
    const status = options.status(ws.id);
    const { counted, costUsd } = countUsage(ws.id, ws.name, options.transcript(ws.id));
    return {
      id: ws.id,
      name: ws.name,
      pid,
      status: status.status,
      cwd: ws.cwd,
      cwdMissing: !existsSync(ws.cwd),
      claudeSessionId: status.claudeSessionId,
      tokens: counted ? { ...counted.totals, counting: counted.scanning, costUsd } : null,
      processes: pid === null ? [] : subtree(procs, pid).map((p) => toSystemProcess(p, listening)),
      history: pid === null ? [] : history.get(ws.id),
    };
  });
  // Everything else the ledger holds: archived workspaces, and earlier sessions of live ones.
  const names = new Map(snapshotSessions.map((ws) => [ws.id, ws.name]));
  for (const entry of ledger.list()) {
    if (!live.has(entry.transcript)) addUsage(entry.workspaceId, names.get(entry.workspaceId) ?? entry.name, entry.buckets);
  }
  const trend = usageTrend(dayTotals, counting, [...unpriced].sort());
  const since = trend.daily[0].day;
  const workspaces = mergeWorkspaces(workspaceUsage)
    .map((w) => ({ ...w, daily: w.daily.filter((d) => d.day >= since) }))
    .filter((w) => w.daily.length);
  return {
    takenAt: new Date().toISOString(),
    helper: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      rssKb: Math.round(process.memoryUsage().rss / 1024),
      cpu: procs.find((p) => p.pid === process.pid)?.cpu ?? 0,
      port: options.port,
      node: process.version,
      commit: options.commit,
      managed,
      clients,
      logPath: paths.logFile,
      configPath: paths.configFile,
      extensionId: config.extensionId,
    },
    sessions: sessionRows,
    usage: { ...trend, hourly: usageByHour(hourTotals), workspaces },
    plan: options.planUsage?.() ?? { limits: [], updatedAt: null },
    warnings: findWarnings(sessionRows, config.limits),
    storage: { uploadsBytes: pathBytes(paths.uploadDir), logBytes: pathBytes(paths.logFile), dataBytes: pathBytes(paths.dataDir) },
    config: {
      defaultCwd: config.defaultCwd,
      promptsFile: config.promptsFile,
      promptsFiles: config.promptsFiles,
      templatesFile: config.templatesFile,
      defaultModel: config.defaultModel,
      claudeCommand: config.claudeCommand,
      claudeArgs: config.claudeArgs,
      repoRoots: config.repoRoots,
      repoDirs: config.repoDirs,
      watchRepos: config.watchRepos,
      limits: config.limits,
      pricing: config.pricing,
      jiraBaseUrl: config.jiraBaseUrl,
    },
    reviews: { fetchedAt: reviews.fetchedAt, count: reviews.items.length, error: reviews.error },
    setup: {
      promptsFileExists: existsSync(config.promptsFile),
      repoRoots: config.repoRoots.map((path) => ({ path, exists: existsSync(path) })),
      statusHooks: paths.hooksFile !== null,
      configProblems: config.problems,
    },
  };
}
