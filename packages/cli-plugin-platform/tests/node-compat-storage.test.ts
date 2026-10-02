import { afterEach, describe, expect, it, mock } from 'bun:test';
import * as host from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeCompatSeed } from '../src/node-compat/seed-virtual';
import type { Preopen, WasiDescriptor } from '../src/node-compat/storage';

const HOST_CODES: Record<string, string> = {
  ENOENT: 'no-entry',
  EEXIST: 'exist',
  ENOTEMPTY: 'not-empty',
  ENOTDIR: 'not-directory',
  EISDIR: 'is-directory',
};

/** componentize-qjs throws a top-level `result` error as an Error carrying `payload`. */
function wasi<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    throw Object.assign(new Error('wasi error'), { payload: HOST_CODES[code] ?? 'io' });
  }
}

/** A wasi:filesystem@0.2.12 descriptor over a real directory, as the host preopens it. */
class HostDescriptor implements WasiDescriptor {
  constructor(readonly path: string) {}
  openAt(
    _pathFlags: { symlinkFollow?: boolean },
    relative: string,
    open: { create?: boolean; truncate?: boolean },
  ): WasiDescriptor {
    const path = join(this.path, relative);
    return wasi(() => {
      if (open.create && !host.existsSync(path)) host.writeFileSync(path, '');
      host.statSync(path);
      if (open.truncate) host.truncateSync(path, 0);
      return new HostDescriptor(path);
    });
  }
  read(length: number, offset: number): [Uint8Array, boolean] {
    const data = host.readFileSync(this.path).subarray(offset, offset + length);
    return [new Uint8Array(data), offset + data.byteLength >= host.statSync(this.path).size];
  }
  write(buffer: Uint8Array, offset: number): number {
    const fd = host.openSync(this.path, 'r+');
    try {
      return host.writeSync(fd, buffer, 0, buffer.byteLength, offset);
    } finally {
      host.closeSync(fd);
    }
  }
  setSize(size: number): void {
    host.truncateSync(this.path, size);
  }
  stat() {
    return hostStat(this.path);
  }
  statAt(_pathFlags: { symlinkFollow?: boolean }, relative: string) {
    return wasi(() => hostStat(join(this.path, relative)));
  }
  createDirectoryAt(relative: string): void {
    wasi(() => host.mkdirSync(join(this.path, relative)));
  }
  readDirectory() {
    const entries = host.readdirSync(this.path, { withFileTypes: true });
    return {
      readDirectoryEntry: () => {
        const entry = entries.shift();
        return entry
          ? { type: entry.isDirectory() ? 'directory' : 'regular-file', name: entry.name }
          : null;
      },
    };
  }
  removeDirectoryAt(relative: string): void {
    wasi(() => host.rmdirSync(join(this.path, relative)));
  }
  renameAt(from: string, target: WasiDescriptor, to: string): void {
    wasi(() => host.renameSync(join(this.path, from), join((target as HostDescriptor).path, to)));
  }
  unlinkFileAt(relative: string): void {
    wasi(() => host.unlinkSync(join(this.path, relative)));
  }
}

function hostStat(path: string) {
  const stat = host.statSync(path);
  return {
    type: stat.isDirectory() ? 'directory' : 'regular-file',
    size: BigInt(stat.size),
    dataModificationTimestamp: { seconds: BigInt(Math.floor(stat.mtimeMs / 1000)), nanoseconds: 0 },
  };
}

let preopenCalls = 0;
const root = host.mkdtempSync(join(tmpdir(), 'di-storage-'));
mock.module('wasi:filesystem/preopens@0.2.12', () => ({
  getDirectories: () => {
    preopenCalls += 1;
    return [[new HostDescriptor(root), '/data']];
  },
}));
const fs = await import('../src/node-compat/fs');
const fsPromises = await import('../src/node-compat/fs-promises');
const { createStorage, storage, storageError } = await import('../src/node-compat/storage');

/** A second workload member: its own preopen of the same host directory. */
function member(path = root, mount = '/data') {
  return createStorage(
    () => [[new HostDescriptor(path), mount] as Preopen],
    () => [mount],
  );
}

afterEach(() => {
  fs.useStorage(storage);
  nodeCompatSeed.files = {};
  host.rmSync(root, { recursive: true, force: true });
  host.mkdirSync(root);
});

describe('guest storage under /data', () => {
  it('shares files written through node:fs between two workload members', async () => {
    const a = member();
    const b = member();
    fs.useStorage(a);
    fs.mkdirSync('/data/notes', { recursive: true });
    fs.writeFileSync('/data/notes/a.txt', 'alpha\n');
    fs.appendFileSync('/data/notes/a.txt', 'again\n');
    fs.useStorage(b);
    expect(fs.readFileSync('/data/notes/a.txt', 'utf8')).toBe('alpha\nagain\n');
    await fsPromises.writeFile('/data/notes/b.txt', new TextEncoder().encode('beta'));
    await fsPromises.appendFile('/data/notes/b.txt', '!');
    fs.useStorage(a);
    expect(new TextDecoder().decode(fs.readFileSync('/data/notes/b.txt') as Uint8Array)).toBe(
      'beta!',
    );
    expect(await fsPromises.readdir('/data/notes')).toEqual(['a.txt', 'b.txt']);
    await fsPromises.mkdir('/data/notes/archive', { recursive: true });
    expect(await fsPromises.readFile('/data/notes/a.txt', 'utf8')).toBe('alpha\nagain\n');
    // The bytes are on the host directory, not in the guest's memory.
    expect(host.readFileSync(join(root, 'notes', 'b.txt'), 'utf8')).toBe('beta!');
    expect(nodeCompatSeed.files).toEqual({});
  });

  it('lists, stats, renames, and removes stored paths', async () => {
    fs.useStorage(member());
    fs.mkdirSync('/data/a/b', { recursive: true });
    fs.mkdirSync('/data/a/b', { recursive: true });
    expect(fs.mkdirSync('/data', { recursive: true })).toBe('/data');
    expect(fs.mkdirSync('/data/c')).toBeUndefined();
    expect(() => fs.mkdirSync('/data/c')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    fs.writeFileSync('/data/a/file.txt', 'x');
    const entries = fs.readdirSync('/data/a', { withFileTypes: true }) as Array<{
      name: string;
      isFile(): boolean;
      isDirectory(): boolean;
    }>;
    expect(entries.map((entry) => [entry.name, entry.isFile(), entry.isDirectory()])).toEqual([
      ['b', false, true],
      ['file.txt', true, false],
    ]);
    const stat = fs.statSync('/data/a/file.txt');
    expect([stat.isFile(), stat.isDirectory(), stat.size, stat.mtimeMs > 0]).toEqual([
      true,
      false,
      1,
      true,
    ]);
    expect((await fsPromises.stat('/data')).isDirectory()).toBe(true);
    expect((await fsPromises.lstat('/data/a')).isDirectory()).toBe(true);
    expect(fs.existsSync('/data/a/file.txt')).toBe(true);
    await fsPromises.access('/data/a/file.txt');
    await fsPromises.rename('/data/a/file.txt', '/data/a/moved.txt');
    expect(fs.existsSync('/data/a/file.txt')).toBe(false);
    await fsPromises.unlink('/data/a/moved.txt');
    expect(() => fs.unlinkSync('/data/a/moved.txt')).toThrow(
      expect.objectContaining({ code: 'ENOENT', syscall: 'unlink', path: '/data/a/moved.txt' }),
    );
    expect(() => fs.rmSync('/data/a')).toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }));
    fs.writeFileSync('/data/a/b/deep.txt', 'deep');
    await fsPromises.rm('/data/a', { recursive: true });
    fs.rmSync('/data/a', { force: true });
    fs.rmSync('/data/c');
    expect(await fsPromises.readdir('/data')).toEqual([]);
    expect(() => fs.readFileSync('/data/missing')).toThrow(
      expect.objectContaining({ code: 'ENOENT', syscall: 'open' }),
    );
    expect(() => fs.renameSync('/data/x', '/tmp/x')).toThrow(
      expect.objectContaining({ code: 'EXDEV' }),
    );
  });

  it('reads and writes stored files through descriptors', () => {
    fs.useStorage(member());
    const fd = fs.openSync('/data/log', 'w');
    expect(fs.writeSync(fd, 'hello')).toBe(5);
    expect(fs.writeSync(fd, ' world')).toBe(6);
    expect(fs.writeSync(fd, 'J', 0, 1, 0)).toBe(1);
    fs.closeSync(fd);
    const append = fs.openSync('/data/log', 'a');
    fs.writeSync(append, '!');
    fs.closeSync(append);
    expect(fs.fstatSync(fs.openSync('/data/log', 'r')).size).toBe(12);
    const reader = fs.openSync('/data/log', 'r');
    const buffer = new Uint8Array(5);
    expect(fs.readSync(reader, buffer)).toBe(5);
    expect(new TextDecoder().decode(buffer)).toBe('Jello');
    expect(fs.readSync(reader, buffer, 0, 5, 6)).toBe(5);
    expect(new TextDecoder().decode(buffer)).toBe('world');
    const created = fs.openSync('/data/new', 'a+');
    fs.closeSync(created);
    expect(fs.readFileSync('/data/new', 'utf8')).toBe('');
    expect(() => fs.openSync('/data/none', 'r')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
    expect(fs.default.promises).toBe(fsPromises.default);
  });

  it('keeps other paths in memory and never reads preopens for them', () => {
    preopenCalls = 0;
    fs.writeFileSync('/app/config.json', '{}');
    fs.appendFileSync('/app/config.json', '\n');
    fs.appendFileSync('/app/new.txt', 'n');
    expect(fs.readFileSync('/app/config.json', 'utf8')).toBe('{}\n');
    expect(nodeCompatSeed.files['/app/new.txt']).toBe('n');
    expect(fs.existsSync('/database/x')).toBe(false);
    expect(preopenCalls).toBe(0);
    // The default storage reads the host preopens once, on the first /data path.
    fs.writeFileSync('/data/x', 'y');
    fs.readFileSync('/data/x');
    expect(preopenCalls).toBe(1);
    expect(host.readFileSync(join(root, 'x'), 'utf8')).toBe('y');
  });

  it('falls back to memory without a /data preopen and ignores a root preopen', () => {
    fs.useStorage(
      createStorage(
        () => [],
        () => ['/data'],
      ),
    );
    fs.writeFileSync('/data/local', 'memory');
    expect(nodeCompatSeed.files['/data/local']).toBe('memory');
    const rooted = createStorage(
      () => [[new HostDescriptor(root), '/'] as Preopen],
      () => ['/data'],
    );
    expect(rooted.owns('/data/local')).toBe(false);
    expect(() => rooted.stat('/data/local')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('uses DI_STORAGE_DIR as the storage mount when it is set', () => {
    const previous = process.env.DI_STORAGE_DIR;
    const custom = join(root, 'custom');
    host.mkdirSync(custom);
    try {
      process.env.DI_STORAGE_DIR = '/srv/state/';
      const configured = createStorage(() => [
        [new HostDescriptor(custom), '/srv/state/'] as Preopen,
      ]);
      expect(configured.owns('/srv/state/a')).toBe(true);
      process.env.DI_STORAGE_DIR = 'relative';
      expect(configured.owns('/srv/state/a')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DI_STORAGE_DIR;
      else process.env.DI_STORAGE_DIR = previous;
    }
  });

  it('maps wasi error codes to Node.js errors', () => {
    expect(storageError('read-only', 'open', '/data/x')).toMatchObject({
      code: 'EROFS',
      errno: -30,
      syscall: 'open',
      path: '/data/x',
    });
    expect(storageError({ payload: 'quota' }, 'write', '/data/x').code).toBe('EIO');
    expect(storageError(new Error('trap'), 'write', '/data/x').code).toBe('EIO');
  });

  it('reports a write the host does not accept and drops descriptors it opened', () => {
    let disposed = 0;
    class Stuck extends HostDescriptor {
      override openAt(...args: Parameters<HostDescriptor['openAt']>): WasiDescriptor {
        const file = super.openAt(...args) as HostDescriptor;
        return Object.assign(new Stuck(file.path), {
          [Symbol.dispose]: () => {
            disposed += 1;
          },
        });
      }
      override write(): number {
        return 0;
      }
      override read(length: number, offset: number): [Uint8Array, boolean] {
        const [data] = super.read(length, offset);
        return [Array.from(data) as unknown as Uint8Array, false];
      }
    }
    host.writeFileSync(join(root, 'f'), 'abc');
    const stuck = createStorage(
      () => [[new Stuck(root), '/data'] as Preopen],
      () => ['/data'],
    );
    expect(new TextDecoder().decode(stuck.readFile('/data/f'))).toBe('abc');
    expect(new TextDecoder().decode(stuck.readAt('/data/f', 2, 1))).toBe('bc');
    expect(() => stuck.writeFile('/data/f', new Uint8Array([1]))).toThrow(
      expect.objectContaining({ code: 'EIO' }),
    );
    expect(disposed).toBe(3);
  });
});

describe('storage WIT wiring', () => {
  it('imports the preview-2 filesystem only when the bundle uses storage', async () => {
    const { runtimeRequirementsFromJavaScript, renderWorldWit } = await import('../src/wit');
    const { hostInterfacesFromRequirements } = await import('../src/host-interface');
    expect(runtimeRequirementsFromJavaScript('export const x = 1;\n')).toEqual([]);
    const requirements = runtimeRequirementsFromJavaScript(
      'import { getDirectories } from "wasi:filesystem/preopens@0.2.12";\n',
    );
    expect(requirements).toEqual([
      {
        package: 'wasi:filesystem',
        version: '0.2.12',
        interfaces: ['types', 'preopens'],
        direction: 'import',
        source: 'node-compat',
      },
    ]);
    const world = renderWorldWit('app', '0.1.0', requirements);
    expect(world).toContain('import wasi:filesystem/types@0.2.12;');
    expect(world).toContain('import wasi:filesystem/preopens@0.2.12;');
    // The host always provides the filesystem; a hostInterfaces entry would be refused.
    expect(hostInterfacesFromRequirements(requirements)).toEqual([]);
  });
});
