export type Bump = 'patch' | 'minor' | 'major';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function isBump(value: string | undefined): value is Bump {
  return value === 'patch' || value === 'minor' || value === 'major';
}

/** The next version after `current`; throws on anything but a plain `x.y.z`. */
export function nextVersion(current: string, bump: Bump): string {
  const match = VERSION.exec(current);
  if (!match) throw new Error(`"${current}" is not an x.y.z version`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
