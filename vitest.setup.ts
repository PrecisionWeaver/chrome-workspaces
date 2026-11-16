import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Points every test's temporary folders into one folder for the run and deletes it afterwards. Tests
 * make dozens of `mkdtemp` folders (harnesses, repos, stores) and few remove their own, so without this
 * they pile up in $TMPDIR. Workers are forked after this runs, so they inherit the TMPDIR it sets.
 */
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'cw-test-run-'));
  process.env.TMPDIR = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
