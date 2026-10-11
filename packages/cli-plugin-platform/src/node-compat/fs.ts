import { invalidArgType, invalidArgValue, outOfRange, validateInteger } from './node-errors';
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

type ReadOptions = {
  offset?: number;
  length?: number;
  position?: number | bigint | null;
};

type WriteOptions = {
  offset?: number;
  length?: number;
  position?: number | null;
};

function validateView(buffer: unknown): asserts buffer is ArrayBufferView {
  if (!ArrayBuffer.isView(buffer)) {
    throw invalidArgType('buffer', 'an instance of Buffer, TypedArray, or DataView', buffer);
  }
}

function viewBytes(buffer: ArrayBufferView): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Node v22 `fs.readSync` argument handling, so only valid u64 lengths and offsets reach
 * the stored descriptor (componentize-qjs 0.4.4-di.5+ traps on any other Number):
 * three arguments (or an object) are options; `length` is truncated with `| 0` and a
 * zero length returns before any other check; `position` `null`/`-1`/`-1n` means the
 * current position. Returns `null` for a zero-length read.
 */
function readRange(
  buffer: ArrayBufferView,
  args: readonly unknown[],
): { offset: number; length: number; position: number | bigint | null } | null {
  let offset = args[0];
  let length = args[1];
  let position = args[2];
  if (args.length <= 1 || typeof offset === 'object') {
    if (offset !== undefined && offset !== null && typeof offset !== 'object') {
      throw invalidArgType('options', 'of type object', offset);
    }
    const options = (offset ?? {}) as ReadOptions;
    offset = options.offset ?? 0;
    length = options.length ?? buffer.byteLength - (offset as number);
    position = options.position ?? null;
  }
  const start = offset === undefined ? 0 : validateInteger(offset, 'offset', 0);
  const count = (length as number) | 0;
  if (count === 0) return null;
  if (buffer.byteLength === 0) {
    throw invalidArgValue('buffer', 'is empty and cannot be written', '<Buffer >');
  }
  if (count < 0) throw outOfRange('length', '>= 0', count);
  if (start + count > buffer.byteLength) {
    throw outOfRange('length', `<= ${buffer.byteLength - start}`, count);
  }
  if (position === null || position === undefined)
    return { offset: start, length: count, position: null };
  if (typeof position === 'number') {
    validateInteger(position, 'position', -1);
    return { offset: start, length: count, position: position === -1 ? null : position };
  }
  if (typeof position === 'bigint') {
    const max = 2n ** 63n - 1n - BigInt(count);
    if (!(position >= -1n && position <= max)) {
      throw outOfRange('position', `>= -1 && <= ${max}`, position);
    }
    return { offset: start, length: count, position: position === -1n ? null : position };
  }
  throw invalidArgType('position', 'of type bigint or integer', position);
}

export function readSync(
  fd: number,
  buffer: ArrayBufferView,
  ...args: [
    offsetOrOptions?: number | ReadOptions | null,
    length?: number,
    position?: number | bigint | null,
  ]
): number {
  validateView(buffer);
  const range = readRange(buffer, args);
  if (range === null) return 0;
  const handle = openHandles.get(fd);
  if (handle === undefined) throw errno('EBADF', 'read', String(fd), -9);
  const { offset, length, position } = range;
  const start = position ?? handle.position;
  const slice = handle.stored
    ? storage.readAt(handle.path, length, start)
    : (() => {
        const content = asBytes(nodeCompatSeed.files[handle.path] ?? '');
        // A BigInt position beyond MAX_SAFE_INTEGER is past the end of any in-memory file.
        if (typeof start === 'bigint' && start > BigInt(content.byteLength))
          return new Uint8Array();
        const from = Number(start);
        return content.subarray(from, from + length);
      })();
  viewBytes(buffer).set(slice, offset);
  if (position === null) handle.position = handle.position + slice.byteLength;
  return slice.byteLength;
}

/** Node's `validateOffsetLengthWrite` plus `validateInt32(length)`. */
function writeRange(
  buffer: ArrayBufferView,
  offsetArg: unknown,
  lengthArg: unknown,
  positionArg: unknown,
) {
  let offset = offsetArg;
  let length = lengthArg;
  let position = positionArg;
  if (typeof offset === 'object') {
    const options = (offset ?? {}) as WriteOptions;
    offset = options.offset ?? 0;
    length = options.length ?? buffer.byteLength - (offset as number);
    position = options.position ?? null;
  }
  const start = offset === undefined || offset === null ? 0 : validateInteger(offset, 'offset', 0);
  const count = typeof length === 'number' ? length : buffer.byteLength - start;
  if (start > buffer.byteLength) throw outOfRange('offset', `<= ${buffer.byteLength}`, start);
  if (count > buffer.byteLength - start) {
    throw outOfRange('length', `<= ${buffer.byteLength - start}`, count);
  }
  if (count < 0) throw outOfRange('length', '>= 0', count);
  if (!Number.isInteger(count)) throw outOfRange('length', 'an integer', count);
  return { bytes: viewBytes(buffer).subarray(start, start + count), position };
}

function encodeString(data: string, encoding: unknown): Uint8Array {
  if (encoding === 'hex' && data.length % 2 !== 0) {
    throw invalidArgValue('encoding', `is invalid for data of length ${data.length}`, "'hex'");
  }
  if (
    typeof encoding === 'string' &&
    typeof Buffer !== 'undefined' &&
    Buffer.isEncoding(encoding)
  ) {
    const encoded = Buffer.from(data, encoding as BufferEncoding);
    return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  }
  return new TextEncoder().encode(data);
}

/**
 * Node v22 `fs.writeSync`, in both forms:
 * - `writeSync(fd, buffer, offset?, length?, position?)` (or an options object), and
 * - `writeSync(fd, string, position?, encoding?)`.
 * Like Node (and libuv), a position that is not a non-negative safe-integer Number
 * (BigInt, NaN, 1.5, -1, ...) writes at the current position, so it never reaches the
 * stored descriptor's u64 offset.
 */
export function writeSync(
  fd: number,
  data: string | ArrayBufferView,
  offsetOrPosition?: number | WriteOptions | null,
  lengthOrEncoding?: number | string | null,
  requestedPosition?: number | bigint | null,
): number {
  let bytes: Uint8Array;
  let position: unknown;
  if (ArrayBuffer.isView(data)) {
    ({ bytes, position } = writeRange(data, offsetOrPosition, lengthOrEncoding, requestedPosition));
  } else if (typeof data === 'string') {
    bytes = encodeString(data, lengthOrEncoding);
    position = offsetOrPosition;
  } else {
    throw invalidArgType(
      'buffer',
      'of type string or an instance of Buffer, TypedArray, or DataView',
      data,
    );
  }
  const handle = openHandles.get(fd);
  if (handle === undefined) throw errno('EBADF', 'write', String(fd), -9);
  const explicit =
    typeof position === 'number' && Number.isSafeInteger(position) && position >= 0
      ? position
      : null;
  if (handle.stored) {
    const target = explicit ?? (handle.flags.includes('a') ? 'end' : handle.position);
    const end = storage.writeAt(handle.path, bytes, target);
    if (explicit === null) handle.position = end;
    return bytes.byteLength;
  }
  const existing = asBytes(nodeCompatSeed.files[handle.path] ?? '');
  const start = explicit ?? (handle.flags.includes('a') ? existing.byteLength : handle.position);
  const next = new Uint8Array(Math.max(existing.byteLength, start + bytes.byteLength));
  next.set(existing, 0);
  next.set(bytes, start);
  nodeCompatSeed.files[handle.path] = new TextDecoder().decode(next);
  if (explicit === null) handle.position = start + bytes.byteLength;
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
