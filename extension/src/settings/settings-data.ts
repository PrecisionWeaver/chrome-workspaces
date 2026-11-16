import type { SystemSnapshot } from '../../../shared/protocol/protocol';
import { el } from '../ui/dom';
import { formatBytes } from '../ui/format';
import { actions, card, guarded, mono, plain, row, type SettingsContext } from './settings-parts';

/** Storage the helper keeps, with the ways to clear it. */
export function dataCard(ctx: SettingsContext, s: SystemSnapshot): HTMLElement {
  return card(
    'Data',
    row('Uploads', formatBytes(s.storage.uploadsBytes), 'Files dropped or pasted into terminals; deleted after a week'),
    row('Helper log', formatBytes(s.storage.logBytes)),
    row('Data folder', formatBytes(s.storage.dataBytes)),
    actions(
      guarded(ctx, 'clear-uploads', 'Clear uploads', 'Delete all uploads?', () => ctx.request({ action: 'clearUploads' })),
      guarded(ctx, 'clear-log', 'Clear log', 'Empty the log?', () => ctx.request({ action: 'clearLog' })),
      plain(
        'Prune worktrees',
        () => ctx.request({ action: 'pruneWorktrees' }),
        "Removes git records of worktrees whose folders are gone, in each workspace's repository",
      ),
      plain('Export workspaces', () => ctx.send({ type: 'exportData' }), 'Downloads the workspace list as JSON'),
    ),
  );
}

/** The effective config, read-only: what the helper read from its file and where it came from. */
export function configCard(s: SystemSnapshot): HTMLElement {
  const { config, helper, setup } = s;
  const map = (record: Record<string, string>) =>
    Object.keys(record).length
      ? Object.entries(record)
          .map(([k, v]) => `${k} → ${v}`)
          .join('\n')
      : 'none';
  return card(
    'Configuration',
    el('p', `Read from ${helper.configPath}. Edit it and restart the helper to change these.`, 'settings-note'),
    ...(setup.configProblems.length ? [row('Ignored entries', el('span', setup.configProblems.join('\n'), 'bad'))] : []),
    row('Default directory', mono(config.defaultCwd)),
    row('Prompts file', mono(config.promptsFile)),
    row('Default model', config.defaultModel ?? "claude's own"),
    row('Command', config.claudeCommand),
    ...(config.claudeArgs.length ? [row('Claude arguments', mono(config.claudeArgs.join(' ')))] : []),
    ...(config.promptsFiles.length ? [row('Team prompts', mono(config.promptsFiles.join('\n')))] : []),
    ...(config.templatesFile ? [row('Team templates', mono(config.templatesFile))] : []),
    row('Repo folders', mono(config.repoRoots.join('\n') || 'none')),
    row('Repo directories', mono(map(config.repoDirs))),
    row('Watched repos', mono(config.watchRepos.join('\n') || 'none')),
    row('Jira', mono(config.jiraBaseUrl ?? 'none')),
    row(
      'Prices',
      mono(
        Object.entries(config.pricing)
          .map(([family, r]) => `${family}: $${r.input} in / $${r.output} out`)
          .join('\n'),
      ),
    ),
    row('Warn above', `${config.limits.memoryWarnMb} MB per workspace · servers idle ${config.limits.idleServerHours} h`),
  );
}
