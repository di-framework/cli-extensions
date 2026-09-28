import { nodeCompatSeed } from './seed-virtual';

export const env: Record<string, string | undefined> = new Proxy(
  Object.create(null) as Record<string, string | undefined>,
  {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return nodeCompatSeed.environ[prop];
    },
    set(_target, prop, value) {
      if (typeof prop === 'string') {
        if (value === undefined) delete nodeCompatSeed.environ[prop];
        else nodeCompatSeed.environ[prop] = String(value);
      }
      return true;
    },
    has(_target, prop) {
      return typeof prop === 'string' && Object.hasOwn(nodeCompatSeed.environ, prop);
    },
    ownKeys() {
      return Object.keys(nodeCompatSeed.environ);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(nodeCompatSeed.environ, prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: nodeCompatSeed.environ[prop],
        };
      }
      return undefined;
    },
    deleteProperty(_target, prop) {
      if (typeof prop === 'string') delete nodeCompatSeed.environ[prop];
      return true;
    },
  },
);

export function cwd(): string {
  return nodeCompatSeed.cwd;
}

export const platform = 'linux';
export const arch = 'wasm32';
export const version = 'v22.0.0';
export const versions = { node: '22.0.0' };
export const argv = ['qjs'];
export const pid = 1;

export function nextTick(callback: () => void): void {
  queueMicrotask(callback);
}

const processObject = {
  env,
  cwd,
  platform,
  arch,
  version,
  versions,
  argv,
  pid,
  nextTick,
};

export default processObject;
