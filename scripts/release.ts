import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isBump, nextVersion } from './release-version';

// Prepares a release: checks, version bump in both files, one commit, on a release branch.
// CI tags and publishes once that commit reaches main (see docs/releasing.md).

const run = (command: string, args: string[]): string => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const step = (command: string, args: string[]): void => void execFileSync(command, args, { stdio: 'inherit' });

const bump = process.argv[2];
if (!isBump(bump)) {
  console.error('usage: npm run release -- <patch|minor|major>');
  process.exit(1);
}

if (run('git', ['branch', '--show-current']) !== 'main') throw new Error('Start from main.');
if (run('git', ['status', '--porcelain'])) throw new Error('The working tree has uncommitted changes.');
run('git', ['fetch', '--quiet']);
if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', '@{u}'])) throw new Error('main is not in sync with origin/main. Pull or push first.');

const rewrite = (file: string, version: string): void => {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
};

const current: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const version = nextVersion(current, bump);
if (run('git', ['tag', '--list', `v${version}`])) throw new Error(`Tag v${version} already exists.`);

step('npm', ['run', 'typecheck']);
step('npm', ['test']);
step('npm', ['run', 'build:extension']);

const branch = `release/v${version}`;
step('git', ['checkout', '-b', branch]);
rewrite('package.json', version);
rewrite('extension/manifest.json', version);
step('git', ['commit', '-am', `release: v${version}`]);

console.log(
  `\nv${current} -> v${version} on ${branch}. Next:\n  git checkout main && git merge --ff-only ${branch} && git push\nCI then tags v${version} and publishes the release.`,
);
