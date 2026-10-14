import { describe, expect, it } from 'vitest';
import {
  diffInstalled,
  parseBattery,
  parseDf,
  parseLogcatLine,
  parsePackageList,
  parseWmSize,
} from './parsers';

describe('adb output parsers', () => {
  it('parses wm size, preferring the override', () => {
    expect(parseWmSize('Physical size: 1080x2400\n')).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize('Physical size: 1440x3120\nOverride size: 1080x2340\n')).toEqual({
      width: 1080,
      height: 2340,
    });
    expect(parseWmSize('error')).toBeNull();
  });

  it('parses dumpsys battery', () => {
    const out =
      'Current Battery Service state:\n  AC powered: false\n  level: 87\n  scale: 100\n  temperature: 312\n';
    expect(parseBattery(out)).toEqual({ level: 87, temperatureC: 31.2 });
  });

  it('parses df for /data', () => {
    const out =
      'Filesystem      1K-blocks     Used Available Use% Mounted on\n/dev/block/dm-5 118888968 76543210  42345758  65% /data\n';
    expect(parseDf(out)).toEqual({ freeMb: 41353, totalMb: 116103 });
  });

  it('diffs package snapshots including reinstalls', () => {
    const before = parsePackageList(
      'package:/data/app/~~a==/com.bank-x==/base.apk=com.bank\npackage:/data/app/~~b==/com.other-y==/base.apk=com.other\n',
    );
    const after = parsePackageList(
      'package:/data/app/~~c==/com.bank-z==/base.apk=com.bank\npackage:/data/app/~~b==/com.other-y==/base.apk=com.other\npackage:/data/app/~~d==/com.new-q==/base.apk=com.new\n',
    );
    expect(diffInstalled(before, after).sort()).toEqual(['com.bank', 'com.new']);
  });

  it('parses logcat threadtime lines', () => {
    const line = '10-13 14:02:03.123  1234  1250 W OkHttp  : A connection was leaked: example.com';
    expect(parseLogcatLine(line, new Date(2026, 9, 13))).toMatchObject({
      level: 'W',
      tag: 'OkHttp',
      pid: 1234,
      tid: 1250,
      message: 'A connection was leaked: example.com',
    });
    expect(parseLogcatLine('--------- beginning of main')).toBeNull();
  });
});

describe('device crash log filter', () => {
  it('keeps native crash lines from the crash buffer and drops noise', async () => {
    const { deviceCrashLog } = await import('./diagnostics');
    const log = [
      'F/libc    ( 4321): Fatal signal 6 (SIGABRT), code -1 in tid 4321 (app_process)',
      "F/DEBUG   (  999): Abort message: 'JNI FatalError called: java.lang.Error thrown during binder transaction'",
      'I/ActivityManager(  500): Start proc 1234:com.example/u0a1 for activity',
    ].join('\n');
    const adb = { shell: async () => log } as unknown as Parameters<typeof deviceCrashLog>[0];
    const lines = await deviceCrashLog(adb, 'SERIAL');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('JNI FatalError');
  });
});
