import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startHelper } from '../helper/src/start-helper';

// One command for a fresh install: setup (passing its flags through), build, and start the helper.
const repo = resolve(import.meta.dirname, '..');
const npm = (...args: string[]) => execFileSync('npm', ['run', '--silent', ...args], { cwd: repo, stdio: 'inherit' });

npm('setup', '--', ...process.argv.slice(2));
npm('build:extension');
await startHelper();
console.log('started the helper; it also starts at login');

console.log(`
Now in Chrome:
  1. chrome://settings/appearance → Side panel position → Left
  2. chrome://extensions → Developer mode → Load unpacked → ${resolve(repo, 'extension', 'dist')}
  3. Click the Chrome Workspaces toolbar icon

If anything looks wrong, run npm run doctor.`);
