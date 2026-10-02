import { getDirectories } from 'wasi:filesystem/preopens@0.2.12';

/** The wasi:filesystem@0.2.12 descriptor methods the storage backend calls. */
export type WasiDescriptor = {
  openAt(
    pathFlags: { symlinkFollow?: boolean },
    path: string,
    openFlags: { create?: boolean; directory?: boolean; exclusive?: boolean; truncate?: boolean },
    flags: { read?: boolean; write?: boolean; mutateDirectory?: boolean },
  ): WasiDescriptor;
  read(length: number, offset: number): [Uint8Array | number[], boolean];
  write(buffer: Uint8Array, offset: number): number;
  setSize(size: number): void;
  stat(): WasiStat;
  statAt(pathFlags: { symlinkFollow?: boolean }, path: string): WasiStat;
  createDirectoryAt(path: string): void;
  readDirectory(): { readDirectoryEntry(): { type: string; name: string } | null };
  removeDirectoryAt(path: string): void;
  renameAt(oldPath: string, newDescriptor: WasiDescriptor, newPath: string): void;
  unlinkFileAt(path: string): void;
};

type WasiStat = {
  type: string;
  size: number | bigint;
  dataModificationTimestamp?: { seconds: number | bigint; nanoseconds: number } | null;
};

export type Preopen = [WasiDescriptor, string];

export type StorageStat = { directory: boolean; size: number; mtimeMs: number };

export type StorageEntry = { name: string; directory: boolean };

/** Node.js errno for each wasi:filesystem error-code the shim reports. */
const ERRNO: Record<string, [string, number]> = {
  'no-entry': ['ENOENT', -2],
  exist: ['EEXIST', -17],
  'not-directory': ['ENOTDIR', -20],
  'is-directory': ['EISDIR', -21],
  'not-empty': ['ENOTEMPTY', -39],
  access: ['EACCES', -13],
  'not-permitted': ['EPERM', -1],
  'read-only': ['EROFS', -30],
  'insufficient-space': ['ENOSPC', -28],
  invalid: ['EINVAL', -22],
  'cross-device': ['EXDEV', -18],
};

/** Default guest storage mount; see DEFAULT_STORAGE_MOUNT in the deploy manifest. */
const DEFAULT_MOUNT = '/data';

const READ_CHUNK = 64 * 1024;

export type StorageError = Error & { code: string; errno: number; syscall: string; path: string };

/** Map a thrown wasi:filesystem error-code to a Node.js-shaped error. */
export function storageError(error: unknown, syscall: string, path: string): StorageError {
  const payload =
    typeof error === 'object' && error !== null && 'payload' in error
      ? (error as { payload: unknown }).payload
      : error;
  const wasiCode = typeof payload === 'string' ? payload : 'io';
  const [code, errno] = ERRNO[wasiCode] ?? ['EIO', -5];
  const result = new Error(`${code}: ${wasiCode}, ${syscall} '${path}'`) as StorageError;
  result.code = code;
  result.errno = errno;
  result.syscall = syscall;
  result.path = path;
  return result;
}

function release(descriptor: WasiDescriptor): void {
  const dispose = (descriptor as { [Symbol.dispose]?: () => void })[Symbol.dispose];
  if (typeof dispose === 'function') dispose.call(descriptor);
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Storage mounts the deploy manifest can request: `/data`, or `DI_STORAGE_DIR` when set. */
function defaultPrefixes(): string[] {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const configured = env?.DI_STORAGE_DIR?.replace(/\/+$/, '');
  return configured?.startsWith('/') ? [DEFAULT_MOUNT, configured] : [DEFAULT_MOUNT];
}

/**
 * Paths under a host-mounted directory (the platform's `/data` preopen) live in
 * wasi:filesystem so every workload member sees them. Only absolute, non-root preopens
 * qualify; every other path stays in the guest's in-memory filesystem. Preopens are
 * read on the first storage path, never at module initialization: only paths under a
 * storage prefix consult them.
 */
export function createStorage(preopens: () => Preopen[], prefixes = defaultPrefixes) {
  let mounts: Array<{ root: WasiDescriptor; path: string }> | undefined;

  function list() {
    if (mounts === undefined) {
      mounts = preopens()
        .map(([root, path]) => ({ root, path: path.replace(/\/+$/, '') }))
        .filter((mount) => mount.path.startsWith('/') && mount.path !== '')
        .sort((left, right) => right.path.length - left.path.length);
    }
    return mounts;
  }

  /** The mount holding an absolute, normalized guest path, and the path inside it. */
  function locate(path: string): { root: WasiDescriptor; relative: string } | undefined {
    for (const mount of list()) {
      if (path === mount.path) return { root: mount.root, relative: '.' };
      if (under(path, mount.path)) {
        return { root: mount.root, relative: path.slice(mount.path.length + 1) };
      }
    }
    return undefined;
  }

  function at<T>(
    path: string,
    syscall: string,
    run: (root: WasiDescriptor, relative: string) => T,
  ) {
    const location = locate(path);
    if (location === undefined) throw storageError('no-entry', syscall, path);
    try {
      return run(location.root, location.relative);
    } catch (error) {
      throw storageError(error, syscall, path);
    }
  }

  function withFile<T>(
    path: string,
    syscall: string,
    open: { create?: boolean; truncate?: boolean },
    access: { read?: boolean; write?: boolean },
    run: (file: WasiDescriptor) => T,
  ): T {
    return at(path, syscall, (root, relative) => {
      const file = root.openAt({ symlinkFollow: true }, relative, open, access);
      try {
        return run(file);
      } finally {
        release(file);
      }
    });
  }

  function readAll(file: WasiDescriptor): Uint8Array {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const [data, end] = file.read(READ_CHUNK, offset);
      const chunk = data instanceof Uint8Array ? data : Uint8Array.from(data);
      chunks.push(chunk);
      offset += chunk.byteLength;
      if (end || chunk.byteLength === 0) break;
    }
    const result = new Uint8Array(offset);
    let position = 0;
    for (const chunk of chunks) {
      result.set(chunk, position);
      position += chunk.byteLength;
    }
    return result;
  }

  function writeAll(file: WasiDescriptor, bytes: Uint8Array, offset: number): void {
    let written = 0;
    while (written < bytes.byteLength) {
      const count = toNumber(file.write(bytes.subarray(written), offset + written));
      if (count <= 0) throw 'io';
      written += count;
    }
  }

  function stat(path: string): StorageStat {
    return at(path, 'stat', (root, relative) => {
      const result =
        relative === '.' ? root.stat() : root.statAt({ symlinkFollow: true }, relative);
      const time = result.dataModificationTimestamp;
      return {
        directory: result.type === 'directory',
        size: toNumber(result.size),
        mtimeMs: time ? toNumber(time.seconds) * 1000 + Math.floor(time.nanoseconds / 1e6) : 0,
      };
    });
  }

  function readdir(path: string): StorageEntry[] {
    return withFile(path, 'scandir', {}, { read: true }, (directory) => {
      const entries: StorageEntry[] = [];
      const stream = directory.readDirectory();
      for (let entry = stream.readDirectoryEntry(); entry; entry = stream.readDirectoryEntry()) {
        entries.push({ name: entry.name, directory: entry.type === 'directory' });
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  function exists(path: string): boolean {
    try {
      stat(path);
      return true;
    } catch {
      return false;
    }
  }

  function mkdir(path: string, recursive: boolean): void {
    if (!recursive) {
      at(path, 'mkdir', (root, relative) => root.createDirectoryAt(relative));
      return;
    }
    const location = locate(path);
    if (location === undefined) throw storageError('no-entry', 'mkdir', path);
    if (location.relative === '.') return;
    let current = '';
    for (const part of location.relative.split('/')) {
      current = current ? `${current}/${part}` : part;
      try {
        location.root.createDirectoryAt(current);
      } catch (error) {
        const failure = storageError(error, 'mkdir', path);
        if (failure.code !== 'EEXIST') throw failure;
      }
    }
  }

  function remove(path: string, recursive: boolean): void {
    if (stat(path).directory) {
      if (recursive) {
        for (const entry of readdir(path)) remove(`${path}/${entry.name}`, true);
      }
      at(path, 'rmdir', (root, relative) => root.removeDirectoryAt(relative));
      return;
    }
    at(path, 'unlink', (root, relative) => root.unlinkFileAt(relative));
  }

  return {
    owns(path: string): boolean {
      if (!prefixes().some((prefix) => under(path, prefix))) return false;
      return locate(path) !== undefined;
    },
    readFile(path: string): Uint8Array {
      return withFile(path, 'open', {}, { read: true }, readAll);
    },
    writeFile(path: string, bytes: Uint8Array): void {
      withFile(path, 'open', { create: true, truncate: true }, { write: true }, (file) =>
        writeAll(file, bytes, 0),
      );
    },
    appendFile(path: string, bytes: Uint8Array): void {
      withFile(path, 'open', { create: true }, { write: true }, (file) =>
        writeAll(file, bytes, toNumber(file.stat().size)),
      );
    },
    readAt(path: string, length: number, offset: number): Uint8Array {
      return withFile(path, 'read', {}, { read: true }, (file) => {
        const [data] = file.read(length, offset);
        return data instanceof Uint8Array ? data : Uint8Array.from(data);
      });
    },
    writeAt(path: string, bytes: Uint8Array, offset: number | 'end'): number {
      return withFile(path, 'write', { create: true }, { write: true }, (file) => {
        const start = offset === 'end' ? toNumber(file.stat().size) : offset;
        writeAll(file, bytes, start);
        return start + bytes.byteLength;
      });
    },
    truncate(path: string): void {
      withFile(path, 'open', { create: true, truncate: true }, { write: true }, () => undefined);
    },
    stat,
    exists,
    readdir,
    mkdir,
    remove,
    unlink(path: string): void {
      at(path, 'unlink', (root, relative) => root.unlinkFileAt(relative));
    },
    rename(from: string, to: string): void {
      const target = locate(to);
      at(from, 'rename', (root, relative) => {
        if (target === undefined || target.root !== root) throw 'cross-device';
        root.renameAt(relative, target.root, target.relative);
      });
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;

/** The guest's storage, backed by the host's preopened directories. */
export const storage: Storage = createStorage(() => getDirectories() as Preopen[]);
