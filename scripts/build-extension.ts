import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const OUT = 'extension/dist';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: ['extension/src/background.ts', 'extension/src/panel.ts'],
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir: OUT,
});

for (const file of ['manifest.json', 'panel.html', 'panel.css']) cpSync(`extension/${file}`, `${OUT}/${file}`);
cpSync('node_modules/@xterm/xterm/css/xterm.css', `${OUT}/xterm.css`);

console.log(`built ${OUT}`);
