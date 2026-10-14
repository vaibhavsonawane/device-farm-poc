import { SCRCPY_SERVER_VERSION } from '@devicelab/protocol';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** SHA-256 of the official scrcpy-server v3.3.1 release asset. */
export const SCRCPY_SERVER_SHA256 =
  'a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8';

/** Returns a human-readable problem with the configured jar, or null if it is the expected file. */
export function checkScrcpyJar(path: string): string | null {
  if (!existsSync(path)) {
    return `scrcpy-server not found at ${path} — run \`pnpm --filter @devicelab/host-agent fetch:scrcpy\` or set scrcpyServerPath`;
  }
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (sha !== SCRCPY_SERVER_SHA256) {
    return `scrcpy-server at ${path} is not the v${SCRCPY_SERVER_VERSION} release (sha256 ${sha.slice(0, 12)}…); the agent requires exactly v${SCRCPY_SERVER_VERSION}`;
  }
  return null;
}
