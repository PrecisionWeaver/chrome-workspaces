import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isBump, lockWithVersion, nextVersion } from './release-version';

// Prepares a release: checks, version bump in package.json, its lockfile and the manifest, one commit, on a release branch.
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

step('npm', ['run', 'check']);
step('npm', ['run', 'typecheck']);
// With coverage, as CI runs it, so a coverage floor fails here and not on the release pull request.
step('npm', ['run', 'test:coverage']);
step('npm', ['run', 'build:extension']);

const branch = `release/v${version}`;
step('git', ['checkout', '-b', branch]);
rewrite('package.json', version);
rewrite('extension/manifest.json', version);
writeFileSync('package-lock.json', `${JSON.stringify(lockWithVersion(JSON.parse(readFileSync('package-lock.json', 'utf8')), version), null, 2)}\n`);
// JSON.stringify's layout is not Biome's, and CI checks formatting.
step('npx', ['biome', 'format', '--write', 'package.json', 'extension/manifest.json']);
step('git', ['commit', '-am', `release: v${version}`]);
// The build above still carries the old version; rebuild so the unpacked extension in extension/dist matches.
step('npm', ['run', 'build:extension']);

console.log(
  `\nv${current} -> v${version} on ${branch}. Next:\n  git push -u origin ${branch} && gh pr create --base main --title "release: v${version}" --fill\nMerge that pull request once CI passes; merging to main then tags v${version} and publishes the release.`,
);
