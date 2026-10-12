import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpdateStatus } from '../../shared/protocol';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const COMMITS_SHOWN = 20;
// Only plain release tags count: `npm run release` makes `vX.Y.Z`.
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

async function git(repo: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: repo, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    return stdout.trim();
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    throw new Error((stderr ?? '').trim().split('\n')[0] || (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Fetches, then says whether this copy is behind the newest release and whether it is safe to fast-forward.
 * A repository with no release tags follows its upstream branch instead.
 */
export async function checkUpdates(repo: string): Promise<UpdateStatus> {
  await git(repo, ['fetch', '--quiet', '--tags']);
  const current = await git(repo, ['rev-parse', '--short', 'HEAD']);
  const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => null);
  const release = (await git(repo, ['tag', '--list', 'v*', '--sort=-v:refname'])).split('\n').find((tag) => RELEASE_TAG.test(tag)) ?? null;
  const dirty = (await git(repo, ['status', '--porcelain', '--untracked-files=no'])) !== '';
  if (!upstream && !release)
    return {
      current,
      branch,
      upstream: null,
      release: null,
      behind: 0,
      ahead: 0,
      dirty,
      commits: [],
      canUpdate: false,
      reason: `${branch} does not track a remote branch.`,
    };

  const target = release ?? '@{u}';
  const [ahead, behind] = (await git(repo, ['rev-list', '--left-right', '--count', `HEAD...${target}`])).split(/\s+/).map(Number);
  const commits = behind
    ? (await git(repo, ['log', `HEAD..${target}`, `-n${COMMITS_SHOWN}`, '--format=%h%x09%s']))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [short, ...subject] = line.split('\t');
          return { short, subject: subject.join('\t') };
        })
    : [];

  let reason: string | null = null;
  if (behind === 0) reason = 'Already up to date.';
  else if (ahead > 0)
    reason = `This copy has ${ahead} commit${ahead === 1 ? '' : 's'} that ${release ?? upstream} does not, so it cannot be fast-forwarded. Update it by hand.`;
  else if (dirty) reason = 'There are uncommitted changes to tracked files. Commit or stash them first.';
  return { current, branch, upstream, release, behind, ahead, dirty, commits, canUpdate: reason === null, reason };
}

export interface UpdateOutcome {
  ok: boolean;
  message: string;
  /** The new code is on disk and built, so the helper should restart to run it. */
  restart: boolean;
}

/**
 * Fast-forwards to the newest release (or the upstream), installs dependencies if they changed, and rebuilds the extension.
 * `run` runs a command line in the repository (through a login shell, so npm is found).
 */
export async function applyUpdate(repo: string, run: (command: string) => Promise<{ output: string; ok: boolean }>): Promise<UpdateOutcome> {
  // Checked again here: the state may have changed since the card was drawn.
  const status = await checkUpdates(repo);
  if (!status.canUpdate) return { ok: false, message: status.reason ?? 'Nothing to update.', restart: false };

  const before = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['merge', '--ff-only', '--quiet', status.release ?? '@{u}'], 120_000);
  const after = await git(repo, ['rev-parse', 'HEAD']);
  const changed = (await git(repo, ['diff', '--name-only', before, after])).split('\n');

  if (changed.some((file) => file === 'package.json' || file === 'package-lock.json')) {
    const install = await run('npm install --no-audit --no-fund 2>&1 | tail -5');
    if (!install.ok)
      return { ok: false, message: `Updated to ${after.slice(0, 7)}, but npm install failed: ${install.output.split('\n').pop()}`, restart: false };
  }
  const build = await run('npm run build:extension 2>&1 | tail -5');
  if (!build.ok)
    return { ok: false, message: `Updated to ${after.slice(0, 7)}, but the extension build failed: ${build.output.split('\n').pop()}`, restart: false };
  return {
    ok: true,
    message: `Updated ${status.current} → ${status.release ?? after.slice(0, 7)} (${status.behind} commit${status.behind === 1 ? '' : 's'}). The helper is restarting; reload the extension to finish.`,
    restart: true,
  };
}
