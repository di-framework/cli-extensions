import { log } from 'wasi:logging/logging@0.1.0-draft';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical';
type LogWriter = (level: Level, context: string, message: string) => void;

/** Context passed with every guest console line; the host tags it with the workload. */
export const CONSOLE_LOG_CONTEXT = 'console';

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value !== 'object' || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * QuickJS has no console. Route each line through wasi:logging, the only guest output
 * that wash 2.8 attributes to a workload; raw stdio reaches the host log unlabeled.
 */
export function createWasiConsole(write: LogWriter) {
  const emit =
    (level: Level) =>
    (...values: unknown[]) => {
      const lines = values.map(formatValue).join(' ').split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) write(level, CONSOLE_LOG_CONTEXT, line);
    };
  return {
    log: emit('info'),
    info: emit('info'),
    debug: emit('debug'),
    trace: emit('trace'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

export function installWasiConsole(write: LogWriter = log): void {
  (globalThis as Record<string, unknown>).console = createWasiConsole(write);
}

installWasiConsole();
