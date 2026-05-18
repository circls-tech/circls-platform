import { pino, type LoggerOptions } from 'pino';
import { env } from '../config/env.js';

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'circls-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const devOptions: LoggerOptions = {
  ...baseOptions,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname,service',
      singleLine: false,
    },
  },
};

export const logger = pino(env.NODE_ENV === 'production' ? baseOptions : devOptions);
