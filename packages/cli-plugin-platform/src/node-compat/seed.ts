import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.di-framework', 'coverage']);
const SEED_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.env']);

export const MAX_SEEDED_FILE_BYTES = 256 * 1024;
export const MAX_SEEDED_TOTAL_BYTES = 1024 * 1024;

export const NODE_COMPAT_SEED_ID = 'virtual:di-framework-node-fs-seed';

export type NodeCompatSeed = {
  files: Record<string, string>;
  environ: Record<string, string>;
  cwd: string;
};

export const EMPTY_NODE_COMPAT_SEED: NodeCompatSeed = {
  files: {},
  environ: {},
  cwd: '/',
};

export function toPosixGuestPath(relativePath: string): string {
  return `/${relativePath.split(sep).join('/')}`;
}

export function compactEnviron(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  if (env === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isSeededName(name: string): boolean {
  return name === '.env' || SEED_EXTENSIONS.has(extname(name));
}

export function collectProjectFiles(projectRoot: string | undefined): Record<string, string> {
  if (projectRoot === undefined) return {};
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (directory: string) => {
    if (total >= MAX_SEEDED_TOTAL_BYTES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total >= MAX_SEEDED_TOTAL_BYTES) return;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !isSeededName(entry.name)) continue;
      let fd: number | undefined;
      try {
        fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        const limit = Math.min(MAX_SEEDED_FILE_BYTES, MAX_SEEDED_TOTAL_BYTES - total);
        if (!stat.isFile() || stat.size > limit) continue;
        // Read at most one byte past the budget, even if the opened file grows.
        const bytes = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < bytes.length) {
          const count = readSync(fd, bytes, size, bytes.length - size, null);
          if (count === 0) break;
          size += count;
        }
        if (size > limit) continue;
        files[toPosixGuestPath(relative(projectRoot, absolute))] = bytes
          .subarray(0, size)
          .toString('utf8');
        total += size;
      } catch {
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  };
  walk(projectRoot);
  return files;
}

export function createNodeCompatSeed(options: {
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
  cwd?: string;
  projectRoot?: string;
}): NodeCompatSeed {
  return {
    files: options.files ?? collectProjectFiles(options.projectRoot),
    environ: compactEnviron(options.env),
    cwd: options.cwd ?? '/',
  };
}

export function renderNodeCompatSeedModule(seed: NodeCompatSeed): string {
  return `export const nodeCompatSeed = ${JSON.stringify({
    files: seed.files,
    environ: seed.environ,
    cwd: seed.cwd,
  })};\n`;
}

export function isNodeCompatSeedSource(source: string): boolean {
  return source.includes('seed-virtual') || source === NODE_COMPAT_SEED_ID;
}
