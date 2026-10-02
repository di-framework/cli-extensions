import { nodeCompatSeed } from './seed-virtual';
import { type Storage, storage as wasiStorage } from './storage';

/** Host-mounted storage; paths outside it stay in the in-memory filesystem below. */
let storage: Storage = wasiStorage;

/** Swap the storage backend (tests run several workload members in one process). */
export function useStorage(next: Storage): Storage {
  const previous = storage;
  storage = next;
  return previous;
}

function stored(path: string): boolean {
  return storage.owns(path);
}

function asBuffer(bytes: Uint8Array): Uint8Array {
  return typeof Buffer === 'undefined' ? bytes : Buffer.from(bytes);
}

type ErrnoException = Error & {
  code: string;
  errno: number;
  syscall: string;
  path: string;
};

function errno(code: string, syscall: string, path: string, errnoValue: number): ErrnoException {
  const error = new Error(
    `${code}: no such file or directory, ${syscall} '${path}'`,
  ) as ErrnoException;
  error.code = code;
  error.errno = errnoValue;
  error.syscall = syscall;
  error.path = path;
  return error;
}

export function normalizeFsPath(path: string, cwd = nodeCompatSeed.cwd): string {
  const base = path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`;
  const parts: string[] = [];
  for (const part of base.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function encodingName(encoding: unknown): string | undefined {
  if (typeof encoding === 'string') return encoding;
  if (encoding !== null && typeof encoding === 'object' && 'encoding' in encoding) {
    const value = (encoding as { encoding?: unknown }).encoding;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function asText(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

function asBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

export function readFileSync(
  path: string,
  encoding?: string | { encoding?: string | null },
): string | Uint8Array {
  const normalized = normalizeFsPath(String(path));
  if (stored(normalized)) {
    const bytes = storage.readFile(normalized);
    return encodingName(encoding) !== undefined ? new TextDecoder().decode(bytes) : asBuffer(bytes);
  }
  const content = nodeCompatSeed.files[normalized];
  if (content === undefined) {
    throw errno('ENOENT', 'open', normalized, -2);
  }
  if (encodingName(encoding) !== undefined) return content;
  const bytes = new TextEncoder().encode(content);
  return asBuffer(bytes);
}

export function writeFileSync(
  path: string,
  data: string | Uint8Array,
  _encoding?: string | { encoding?: string | null },
): void {
  const normalized = normalizeFsPath(String(path));
  if (stored(normalized)) {
    storage.writeFile(normalized, asBytes(data));
    return;
  }
  nodeCompatSeed.files[normalized] = asText(data);
}

export function appendFileSync(
  path: string,
  data: string | Uint8Array,
  _encoding?: string | { encoding?: string | null },
): void {
  const normalized = normalizeFsPath(String(path));
  if (stored(normalized)) {
    storage.appendFile(normalized, asBytes(data));
    return;
  }
  nodeCompatSeed.files[normalized] = (nodeCompatSeed.files[normalized] ?? '') + asText(data);
}

function directoryKey(path: string): string {
  const normalized = normalizeFsPath(path).replace(/\/$/, '');
  return normalized === '' ? '/' : `${normalized}/`;
}

export function existsSync(path: string): boolean {
  const normalized = normalizeFsPath(String(path));
  if (stored(normalized)) return storage.exists(normalized);
  return normalized in nodeCompatSeed.files || directoryKey(normalized) in nodeCompatSeed.files;
}

export function mkdirSync(
  path: string,
  options?: { recursive?: boolean } | number,
): string | undefined {
  const normalized = normalizeFsPath(String(path)).replace(/\/$/, '') || '/';
  const recursive = typeof options === 'object' && options?.recursive === true;
  if (stored(normalized)) {
    storage.mkdir(normalized, recursive);
    return recursive ? normalized : undefined;
  }
  if (normalized in nodeCompatSeed.files || directoryKey(normalized) in nodeCompatSeed.files) {
    if (recursive) return undefined;
    const error = errno('EEXIST', 'mkdir', normalized, -17);
    error.message = `EEXIST: file already exists, mkdir '${normalized}'`;
    throw error;
  }
  if (recursive) {
    const parts = normalized.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      nodeCompatSeed.files[directoryKey(current)] = '';
    }
  } else {
    nodeCompatSeed.files[directoryKey(normalized)] = '';
  }
  return recursive ? normalized : undefined;
}

export function readdirSync(
  path: string,
  options?: { withFileTypes?: boolean } | string | null,
): string[] | Array<{ name: string; isFile(): boolean; isDirectory(): boolean }> {
  const normalized = normalizeFsPath(String(path)).replace(/\/$/, '') || '/';
  const withFileTypes =
    options !== null && typeof options === 'object' && options.withFileTypes === true;
  if (stored(normalized)) {
    const entries = storage.readdir(normalized);
    if (!withFileTypes) return entries.map((entry) => entry.name);
    return entries.map((entry) => ({
      name: entry.name,
      isFile: () => !entry.directory,
      isDirectory: () => entry.directory,
    }));
  }
  const prefix = normalized === '/' ? '/' : `${normalized}/`;
  const names = new Set<string>();
  for (const key of Object.keys(nodeCompatSeed.files)) {
    if (!key.startsWith(prefix) || key === prefix) continue;
    const rest = key.slice(prefix.length);
    const name = rest.split('/')[0];
    if (name) names.add(name.replace(/\/$/, ''));
  }
  const list = [...names].sort();
  if (!withFileTypes) return list;
  return list.map((name) => {
    const child = normalizeFsPath(`${normalized}/${name}`);
    const isDirectory =
      directoryKey(child) in nodeCompatSeed.files && !(child in nodeCompatSeed.files);
    return {
      name,
      isFile: () => !isDirectory,
      isDirectory: () => isDirectory,
    };
  });
}

export function statSync(path: string): {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
} {
  const normalized = normalizeFsPath(String(path));
  if (stored(normalized)) {
    const result = storage.stat(normalized);
    return {
      isFile: () => !result.directory,
      isDirectory: () => result.directory,
      size: result.size,
      mtimeMs: result.mtimeMs,
    };
  }
  const content = nodeCompatSeed.files[normalized];
  if (content !== undefined) {
    return {
      isFile: () => true,
      isDirectory: () => false,
      size: new TextEncoder().encode(content).byteLength,
      mtimeMs: Date.now(),
    };
  }
  if (directoryKey(normalized) in nodeCompatSeed.files) {
    return {
      isFile: () => false,
      isDirectory: () => true,
      size: 0,
      mtimeMs: Date.now(),
    };
  }
  throw errno('ENOENT', 'stat', normalized, -2);
}

export function lstatSync(path: string) {
  return statSync(path);
}

export function fstatSync(fd: number) {
  const handle = openHandles.get(fd);
  if (handle === undefined) throw errno('EBADF', 'fstat', String(fd), -9);
  return statSync(handle.path);
}

let nextFd = 3;
const openHandles = new Map<
  number,
  { path: string; position: number; flags: string; stored: boolean }
>();

export function openSync(path: string, flags: string | number = 'r', _mode?: number): number {
  const normalized = normalizeFsPath(String(path));
  const flag = typeof flags === 'string' ? flags : 'r';
  const writing = flag.includes('w') || flag.includes('a') || flag.includes('+');
  if (stored(normalized)) {
    if (flag.includes('w')) storage.truncate(normalized);
    else if (writing && !storage.exists(normalized))
      storage.writeFile(normalized, new Uint8Array());
    else if (!writing) storage.stat(normalized);
    const fd = nextFd++;
    openHandles.set(fd, { path: normalized, position: 0, flags: flag, stored: true });
    return fd;
  }
  if (!(normalized in nodeCompatSeed.files) && !writing) {
    throw errno('ENOENT', 'open', normalized, -2);
  }
  if (writing && !(normalized in nodeCompatSeed.files)) {
    nodeCompatSeed.files[normalized] = '';
  }
  const fd = nextFd++;
  openHandles.set(fd, {
    path: normalized,
    position: flag.includes('a') ? Number.MAX_SAFE_INTEGER : 0,
    flags: flag,
    stored: false,
  });
  return fd;
}

export function closeSync(fd: number): void {
  if (!openHandles.delete(fd)) throw errno('EBADF', 'close', String(fd), -9);
}

export function readSync(
  fd: number,
  buffer: Uint8Array,
  offset = 0,
  length = buffer.byteLength - offset,
  position: number | null = null,
): number {
  const handle = openHandles.get(fd);
  if (handle === undefined) throw errno('EBADF', 'read', String(fd), -9);
  const start = position === null ? handle.position : position;
  const slice = handle.stored
    ? storage.readAt(handle.path, length, start)
    : asBytes(nodeCompatSeed.files[handle.path] ?? '').subarray(start, start + length);
  buffer.set(slice, offset);
  if (position === null) handle.position = start + slice.byteLength;
  return slice.byteLength;
}

export function writeSync(
  fd: number,
  data: string | Uint8Array,
  offset?: number,
  length?: number,
  position?: number | null,
): number {
  const handle = openHandles.get(fd);
  if (handle === undefined) throw errno('EBADF', 'write', String(fd), -9);
  const bytes = asBytes(data).subarray(
    offset ?? 0,
    (offset ?? 0) + (length ?? asBytes(data).byteLength),
  );
  if (handle.stored) {
    const target = position ?? (handle.flags.includes('a') ? 'end' : handle.position);
    const end = storage.writeAt(handle.path, bytes, target);
    if (position == null) handle.position = end;
    return bytes.byteLength;
  }
  const existing = asBytes(nodeCompatSeed.files[handle.path] ?? '');
  const start =
    position == null
      ? handle.flags.includes('a')
        ? existing.byteLength
        : handle.position
      : position;
  const next = new Uint8Array(Math.max(existing.byteLength, start + bytes.byteLength));
  next.set(existing, 0);
  next.set(bytes, start);
  nodeCompatSeed.files[handle.path] = new TextDecoder().decode(next);
  if (position == null) handle.position = start + bytes.byteLength;
  return bytes.byteLength;
}

export function createReadStream(path: string): {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  [Symbol.asyncIterator](): AsyncGenerator<Uint8Array>;
} {
  const data = asBytes(readFileSync(path) as string | Uint8Array);
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const stream = {
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      if (event === 'data') queueMicrotask(() => listener(data));
      if (event === 'end') queueMicrotask(() => listener());
      return stream;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        listener(...args);
        const list = listeners.get(event) ?? [];
        listeners.set(
          event,
          list.filter((entry) => entry !== wrapped),
        );
      };
      return stream.on(event, wrapped);
    },
    async *[Symbol.asyncIterator]() {
      yield data;
    },
  };
  return stream;
}

export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
  const normalized = normalizeFsPath(String(path));
  if (stored(normalized)) {
    if (options?.force && !storage.exists(normalized)) return;
    storage.remove(normalized, options?.recursive === true);
    return;
  }
  const prefix = normalized === '/' ? '/' : `${normalized}/`;
  const keys = Object.keys(nodeCompatSeed.files).filter(
    (key) => key === normalized || key === directoryKey(normalized) || key.startsWith(prefix),
  );
  if (keys.length === 0) {
    if (options?.force) return;
    throw errno('ENOENT', 'rm', normalized, -2);
  }
  for (const key of keys) delete nodeCompatSeed.files[key];
}

export function unlinkSync(path: string): void {
  const normalized = normalizeFsPath(String(path));
  if (stored(normalized)) {
    storage.unlink(normalized);
    return;
  }
  if (!(normalized in nodeCompatSeed.files)) throw errno('ENOENT', 'unlink', normalized, -2);
  delete nodeCompatSeed.files[normalized];
}

export function renameSync(from: string, to: string): void {
  const source = normalizeFsPath(String(from));
  const target = normalizeFsPath(String(to));
  if (stored(source) || stored(target)) {
    storage.rename(source, target);
    return;
  }
  if (!(source in nodeCompatSeed.files) && !(directoryKey(source) in nodeCompatSeed.files)) {
    throw errno('ENOENT', 'rename', source, -2);
  }
  if (source in nodeCompatSeed.files) {
    nodeCompatSeed.files[target] = nodeCompatSeed.files[source]!;
    delete nodeCompatSeed.files[source];
    return;
  }
  const prefix = directoryKey(source);
  const targetPrefix = directoryKey(target);
  for (const key of Object.keys(nodeCompatSeed.files)) {
    if (key === prefix || key.startsWith(prefix)) {
      const next = targetPrefix + key.slice(prefix.length);
      nodeCompatSeed.files[next] = nodeCompatSeed.files[key]!;
      delete nodeCompatSeed.files[key];
    }
  }
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export function accessSync(path: string, _mode?: number): void {
  if (!existsSync(path)) throw errno('ENOENT', 'access', normalizeFsPath(String(path)), -2);
}

type Encoding = string | { encoding?: string | null };

/** `fs/promises`: the synchronous operations above, settled as promises. */
export const promises = {
  access: async (path: string, mode?: number) => accessSync(path, mode),
  appendFile: async (path: string, data: string | Uint8Array, encoding?: Encoding) =>
    appendFileSync(path, data, encoding),
  mkdir: async (path: string, options?: { recursive?: boolean } | number) =>
    mkdirSync(path, options),
  readFile: async (path: string, encoding?: Encoding) => readFileSync(path, encoding),
  readdir: async (path: string, options?: { withFileTypes?: boolean } | string | null) =>
    readdirSync(path, options),
  rename: async (from: string, to: string) => renameSync(from, to),
  rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) =>
    rmSync(path, options),
  stat: async (path: string) => statSync(path),
  lstat: async (path: string) => lstatSync(path),
  unlink: async (path: string) => unlinkSync(path),
  writeFile: async (path: string, data: string | Uint8Array, encoding?: Encoding) =>
    writeFileSync(path, data, encoding),
};

export default {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  promises,
};
