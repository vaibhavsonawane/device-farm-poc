import type { LogLine } from '@devicelab/shared-types';

/** `wm size` → physical (or override) size. */
export function parseWmSize(out: string): { width: number; height: number } | null {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(out);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(out);
  const m = override ?? physical;
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** `dumpsys battery` → level and temperature (°C). */
export function parseBattery(out: string): { level: number | null; temperatureC: number | null } {
  const level = /^\s*level:\s*(\d+)/m.exec(out);
  const scale = /^\s*scale:\s*(\d+)/m.exec(out);
  const temp = /^\s*temperature:\s*(\d+)/m.exec(out);
  const l = level ? Number(level[1]) : null;
  const s = scale ? Number(scale[1]) : 100;
  return {
    level: l === null ? null : Math.max(0, Math.min(100, Math.round((l / (s || 100)) * 100))),
    temperatureC: temp ? Number(temp[1]) / 10 : null,
  };
}

/** `df /data` (toybox) → free/total MB. */
export function parseDf(out: string): { freeMb: number; totalMb: number } | null {
  const line = out
    .trim()
    .split('\n')
    .find((l) => /\/data\s*$/.test(l));
  if (!line) return null;
  const cols = line.trim().split(/\s+/);
  // Filesystem 1K-blocks Used Available Use% Mounted on
  const total = Number(cols[1]);
  const avail = Number(cols[3]);
  if (!Number.isFinite(total) || !Number.isFinite(avail)) return null;
  return { freeMb: Math.round(avail / 1024), totalMb: Math.round(total / 1024) };
}

/** `pm list packages [-f]` → package ids (or full lines for diffing with -f). */
export function parsePackageList(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('package:'))
    .map((l) => l.slice('package:'.length));
}

/** From a `pm list packages -f` line ("/data/app/…/base.apk=com.foo") take the package id. */
export function packageFromPathLine(line: string): string {
  const i = line.lastIndexOf('=');
  return i >= 0 ? line.slice(i + 1) : line;
}

/** Packages new or reinstalled between two `pm list packages -3 -f` snapshots. */
export function diffInstalled(before: string[], after: string[]): string[] {
  const prev = new Set(before);
  return [...new Set(after.filter((l) => !prev.has(l)).map(packageFromPathLine))];
}

// threadtime: "10-13 14:02:03.123  1234  1250 I ActivityManager: message"
const THREADTIME =
  /^(\d\d)-(\d\d)\s+(\d\d):(\d\d):(\d\d)\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*:\s(.*)$/;

export function parseLogcatLine(line: string, now = new Date()): LogLine | null {
  const m = THREADTIME.exec(line);
  if (!m) return null;
  const [, mo, d, h, mi, s, ms, pid, tid, level, tag, message] = m;
  const ts = new Date(
    now.getFullYear(),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms),
  ).getTime();
  return {
    ts,
    level: (level === 'S' ? 'V' : level) as LogLine['level'],
    tag: tag ?? '',
    pid: Number(pid),
    tid: Number(tid),
    message: message ?? '',
  };
}
