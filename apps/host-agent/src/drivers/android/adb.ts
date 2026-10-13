import { Adb } from '@devicefarmer/adbkit';
import { execFile } from 'node:child_process';
import { type Duplex } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AdbClient = ReturnType<typeof Adb.createClient>;

/** Single-quote a value for `adb shell` (device-side sh). */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Thin promise wrapper around adbkit with the few helpers DeviceLab needs. */
export class AdbBridge {
  readonly client: AdbClient;

  constructor(private readonly opts: { host: string; port: number; bin: string }) {
    this.client = Adb.createClient({ host: opts.host, port: opts.port, bin: opts.bin });
  }

  device(serial: string): ReturnType<AdbClient['getDevice']> {
    return this.client.getDevice(serial);
  }

  /** Run a shell command and return stdout as text. */
  async shell(serial: string, command: string, timeoutMs = 30_000): Promise<string> {
    const run = async (): Promise<string> => {
      const stream = await this.device(serial).shell(command);
      const out = await Adb.util.readAll(stream);
      return out.toString('utf8');
    };
    return withTimeout(run(), timeoutMs, `adb shell timed out: ${command.slice(0, 60)}`);
  }

  /** Long-running shell (logcat, scrcpy-server). */
  async shellStream(serial: string, command: string): Promise<Duplex> {
    return this.device(serial).shell(command);
  }

  async push(serial: string, localPath: string, remotePath: string, mode = 0o644): Promise<void> {
    const transfer = await this.device(serial).push(localPath, remotePath, mode);
    await new Promise<void>((resolve, reject) => {
      transfer.on('end', () => resolve());
      transfer.on('error', reject);
    });
  }

  async forward(serial: string, local: string, remote: string): Promise<void> {
    await this.device(serial).forward(local, remote);
  }

  /** adbkit has no forward --remove; use the adb binary. */
  async removeForward(serial: string, local: string): Promise<void> {
    await execFileAsync(
      this.opts.bin,
      [
        '-H',
        this.opts.host,
        '-P',
        String(this.opts.port),
        '-s',
        serial,
        'forward',
        '--remove',
        local,
      ],
      {
        timeout: 10_000,
      },
    ).catch(() => undefined);
  }

  async screencap(serial: string): Promise<Buffer> {
    const stream = await this.device(serial).screencap();
    return Adb.util.readAll(stream);
  }

  async getProperties(serial: string): Promise<Record<string, string>> {
    return (await this.device(serial).getProperties()) as Record<string, string>;
  }

  async reboot(serial: string): Promise<void> {
    await this.device(serial).reboot();
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
