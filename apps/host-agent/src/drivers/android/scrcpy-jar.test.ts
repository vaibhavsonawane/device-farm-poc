import { SCRCPY_SERVER_VERSION } from '@devicelab/protocol';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentConfigSchema } from '../../config';
import { SCRCPY_SERVER_SHA256 } from './scrcpy-jar';

describe('scrcpy-server pin', () => {
  it('keeps the protocol version, checksum, fetch script and default path in sync', () => {
    const script = readFileSync(
      path.resolve(__dirname, '../../../scripts/fetch-scrcpy-server.mjs'),
      'utf8',
    );
    expect(script).toContain(`const VERSION = '${SCRCPY_SERVER_VERSION}'`);
    expect(script).toContain(`const SHA256 = '${SCRCPY_SERVER_SHA256}'`);
    const cfg = agentConfigSchema.parse({
      serverUrl: 'http://x.local',
      agentToken: 'dlh_aaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(path.basename(cfg.scrcpyServerPath)).toBe(`scrcpy-server-v${SCRCPY_SERVER_VERSION}`);
  });

  it('pins 3.3.4 or later (3.3.1 aborts on Android 16 QPR2+, scrcpy #6362)', () => {
    const [maj, min, patch] = SCRCPY_SERVER_VERSION.split('.').map(Number);
    expect(maj! * 10_000 + min! * 100 + patch!).toBeGreaterThanOrEqual(30304);
  });
});
