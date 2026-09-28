import { getEnvironment } from 'wasi:cli/environment@0.3.0';
import { env } from './process';

let environmentReady = false;
let initialized: Promise<typeof import('virtual:di-framework-application')> | undefined;

/** Copy host-provided WASI environment into the Node process.env polyfill once. */
export function ensureWasiEnvironment(): void {
  if (environmentReady) return;
  for (const [name, value] of getEnvironment()) env[name] = value;
  // Kubernetes owns scheduling, including during registration and service construction.
  env.DI_CRON_MODE = 'external';
  environmentReady = true;
}

/** Defer application module evaluation until a runtime invocation, after WASI environment setup. */
export function loadApplication() {
  initialized ??= (async () => {
    ensureWasiEnvironment();
    await import('virtual:di-framework-wasmcloud-guests');
    await import('virtual:di-framework-wasmcloud-actors');
    return import('virtual:di-framework-application');
  })();
  return initialized;
}
