#!/usr/bin/env node
// Download scrcpy-server v3.3.1 (Apache-2.0, Genymobile) into vendor/ and verify its SHA-256.
// Air-gapped hosts: copy the file in manually and set scrcpyServerPath in agent.config.json.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '3.3.1';
const SHA256 = 'a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8';
const URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
const dest = path.join(dir, `scrcpy-server-v${VERSION}`);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(dest) && sha(readFileSync(dest)) === SHA256) {
  console.log(`scrcpy-server v${VERSION} already present: ${dest}`);
  process.exit(0);
}
console.log(`Downloading ${URL}`);
const res = await fetch(URL);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = sha(buf);
if (got !== SHA256) throw new Error(`checksum mismatch: expected ${SHA256}, got ${got}`);
mkdirSync(dir, { recursive: true });
writeFileSync(dest, buf);
console.log(`Saved ${dest} (sha256 ${got})`);
