import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Points every test's temporary folders into one folder for the run and deletes it afterwards. Tests
 * make dozens of `mkdtemp` folders (harnesses, repos, stores) and few remove their own, so without this
 * they pile up in $TMPDIR. Workers are forked after this runs, so they inherit the TMPDIR it sets.
 * It also gives git a committer, which the code under test commits with: a machine with no global git identity
 * (a CI runner on Linux) would otherwise refuse with "Author identity unknown".
 */
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'cw-test-run-'));
  process.env.TMPDIR = dir;
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  });
  return () => rmSync(dir, { recursive: true, force: true });
}
