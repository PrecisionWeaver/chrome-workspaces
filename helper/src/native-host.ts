import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeHostReply } from '../../shared/protocol';
import { DATA_DIR, PORT } from './config';

let input = Buffer.alloc(0);
let answered = false;

function reply(message: NativeHostReply): void {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
}

process.stdin.on('data', (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  if (answered || input.length < 4 || input.length < 4 + input.readUInt32LE(0)) return;
  answered = true;

  try {
    const token = readFileSync(join(DATA_DIR, 'token'), 'utf8').trim();
    reply({ ok: true, token, port: PORT });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
