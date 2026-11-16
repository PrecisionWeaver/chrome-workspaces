import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isBump, lockWithVersion, nextVersion } from './release-version';

describe('nextVersion', () => {
  it('bumps each part and resets the ones after it', () => {
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0');
    expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
  });

  it('rejects versions it cannot bump', () => {
    expect(() => nextVersion('1.0', 'patch')).toThrow();
    expect(() => nextVersion('1.0.0-beta', 'patch')).toThrow();
  });

  it('recognises the three bump names', () => {
    expect(['patch', 'minor', 'major'].every(isBump)).toBe(true);
    expect(isBump('huge')).toBe(false);
    expect(isBump(undefined)).toBe(false);
  });
});

describe('lockWithVersion', () => {
  it("sets the lockfile's version and its root package's, and leaves the rest alone", () => {
    const lock = { name: 'x', version: '0.1.0', packages: { '': { version: '0.1.0', license: 'MIT' }, 'node_modules/a': { version: '1.0.0' } } };
    expect(lockWithVersion(lock, '0.2.0')).toEqual({
      name: 'x',
      version: '0.2.0',
      packages: { '': { version: '0.2.0', license: 'MIT' }, 'node_modules/a': { version: '1.0.0' } },
    });
    expect(lock.version).toBe('0.1.0');
  });
});

describe('versions', () => {
  it('are the same in package.json, its lockfile and the manifest, because a release bumps all three', () => {
    const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')).version;
    expect(read('extension/manifest.json')).toBe(read('package.json'));
    expect(read('package-lock.json')).toBe(read('package.json'));
    expect(JSON.parse(readFileSync('package-lock.json', 'utf8')).packages[''].version).toBe(read('package.json'));
  });
});
