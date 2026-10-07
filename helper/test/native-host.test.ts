import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeHostReply } from '../../shared/protocol';
import { PORT } from '../src/config';

const HOST_SCRIPT = resolve(import.meta.dirname, '../src/native-host.ts');

function callHost(dataDir: string): Promise<NativeHostReply> {
  const child = spawn(process.execPath, ['--import', 'tsx', HOST_SCRIPT], {
    env: { ...process.env, CW_DATA_DIR: dataDir },
  });
  const chunks: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  const body = Buffer.from(JSON.stringify({ type: 'hello' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));

  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      if (out.length < 4) return reject(new Error(`native host sent no reply: ${stderr}`));
      resolvePromise(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString()) as NativeHostReply);
    });
  });
}

describe('native host', () => {
  it('replies with the token and helper port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-host-'));
    writeFileSync(join(dir, 'token'), `${'c'.repeat(64)}\n`);
    expect(await callHost(dir)).toEqual({ ok: true, token: 'c'.repeat(64), port: PORT });
  });

  it('reports an error when the helper has not created a token yet', async () => {
    const reply = await callHost(mkdtempSync(join(tmpdir(), 'cw-host-')));
    expect(reply.ok).toBe(false);
  });
});
