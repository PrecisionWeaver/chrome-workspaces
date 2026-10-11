import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeHostReply, NativeHostRequest, NativeStartReply } from '../../shared/protocol';
import { DATA_DIR, PORT } from './config';
import { startHelper } from './start-helper';

let input = Buffer.alloc(0);
let answered = false;

function reply(message: NativeHostReply | NativeStartReply): void {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

process.stdin.on('data', (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  if (answered || input.length < 4 || input.length < 4 + input.readUInt32LE(0)) return;
  answered = true;

  let request: Partial<NativeHostRequest> = {};
  try {
    request = JSON.parse(input.subarray(4, 4 + input.readUInt32LE(0)).toString());
  } catch {
    // An unreadable request gets the token, as before there were requests.
  }

  if (request.type === 'start') {
    startHelper().then(
      () => reply({ ok: true }),
      (error) => reply({ ok: false, error: errorText(error) }),
    );
    return;
  }

  try {
    const token = readFileSync(join(DATA_DIR, 'token'), 'utf8').trim();
    reply({ ok: true, token, port: PORT });
  } catch (error) {
    reply({ ok: false, error: errorText(error) });
  }
});
