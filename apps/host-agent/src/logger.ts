import pino from 'pino';

/** Structured JSON logs (pipe through `pino-pretty` for humans). */
export const logger = pino({
  name: 'devicelab-agent',
  level: process.env.LOG_LEVEL ?? 'info',
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = pino.Logger;
