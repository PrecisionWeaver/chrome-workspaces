import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
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

// panel.css @imports one file per view; bundling inlines them, in order, into one stylesheet.
await build({ entryPoints: ['extension/panel.css'], bundle: true, outfile: `${OUT}/panel.css` });

for (const file of ['manifest.json', 'panel.html']) cpSync(`extension/${file}`, `${OUT}/${file}`);
cpSync('node_modules/@xterm/xterm/css/xterm.css', `${OUT}/xterm.css`);

// PNGs are rendered here rather than committed; small sizes use the simplified artwork.
mkdirSync(`${OUT}/icons`);
for (const size of [16, 32, 48, 128]) {
  const svg = readFileSync(size <= 32 ? 'extension/icons/icon-small.svg' : 'extension/icons/icon.svg');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(`${OUT}/icons/icon-${size}.png`, png);
}

console.log(`built ${OUT}`);
