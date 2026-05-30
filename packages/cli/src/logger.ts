import { chalkStderr } from 'chalk';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const noop = (): undefined => {
  return undefined;
};

export const consoleLogger: Logger = {
  debug(message) {
    console.debug(chalkStderr.dim(message));
  },
  info(message) {
    console.info(message);
  },
  warn(message) {
    console.warn(chalkStderr.yellow(message));
  },
  error(message) {
    console.error(chalkStderr.red(message));
  },
};

export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};
