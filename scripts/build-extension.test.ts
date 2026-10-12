import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const dist = join(import.meta.dirname, '..', 'extension', 'dist');
const read = (file: string) => readFileSync(join(dist, file), 'utf8');

// Chrome can't be driven from here, so this catches what it can: a build that leaves the panel with a missing script, stylesheet or icon.
describe('built extension', () => {
  beforeAll(() => {
    execFileSync('npx', ['tsx', 'scripts/build-extension.ts'], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore' });
  }, 60_000);

  it('has every file the manifest names', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      icons: Record<string, string>;
      background: { service_worker: string };
      side_panel: { default_path: string };
      action: { default_icon: Record<string, string> };
    };
    const files = [
      manifest.background.service_worker,
      manifest.side_panel.default_path,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ];
    expect(files.filter((file) => !existsSync(join(dist, file)))).toEqual([]);
  });

  it('has every script and stylesheet the panel page loads', () => {
    const page = read('panel.html');
    const assets = [...page.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map((match) => match[1]);
    expect(assets).toEqual(expect.arrayContaining(['panel.js', 'panel.css', 'xterm.css']));
    expect(assets.filter((file) => !existsSync(join(dist, file)))).toEqual([]);
  });

  it('bundles every stylesheet into panel.css, with no import left for Chrome to miss', () => {
    const css = read('panel.css');
    expect(css).not.toContain('@import');
    for (const marker of ['#settings', '#palette', '.section-header', ':root[data-theme=light]']) expect(css).toContain(marker);
  });
});
