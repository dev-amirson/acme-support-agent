/** The subset of pino's API the app depends on — lets scripts and tests pass a console logger. */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child?(bindings: Record<string, unknown>): Logger;
}

export const consoleLogger: Logger = {
  debug: () => undefined,
  info: (obj, msg) => console.log(msg ?? '', typeof obj === 'string' ? obj : JSON.stringify(obj)),
  warn: (obj, msg) => console.warn(msg ?? '', typeof obj === 'string' ? obj : JSON.stringify(obj)),
  error: (obj, msg) => console.error(msg ?? '', obj),
};
