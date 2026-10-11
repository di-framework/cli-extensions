import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComponent } from '../src/build';
import { DEFAULT_DEPS } from '../src/deps';
import { loadProject } from '../src/project';
import { captureIo, makeProject, patchedComponentizeQjsPath } from './helpers';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ASSETS = join(PLUGIN_ROOT, 'dist', 'assets');
const PINNED_QJS = '0.4.4-di.5';

const wasmtime = DEFAULT_DEPS.wasmtimeBinaryPath();
const qjs = patchedComponentizeQjsPath();
const missing = [
  wasmtime === undefined ? 'wasmtime not on PATH' : undefined,
  qjs === undefined
    ? 'componentize-qjs CLI not installed'
    : qjs.includes(PINNED_QJS)
      ? undefined
      : `componentize-qjs CLI is not ${PINNED_QJS} (${qjs})`,
  existsSync(join(DIST_ASSETS, 'http-adapter.js')) ? undefined : 'dist/assets not built',
  // The build composes the packaged SQLite provider with wac.
  Bun.which('wac') !== null ||
  (process.env.DF_SQLITE_TOOLS_DIR !== undefined &&
    existsSync(join(process.env.DF_SQLITE_TOOLS_DIR, 'bin', 'wac')))
    ? undefined
    : 'wac not on PATH',
].filter((reason): reason is string => reason !== undefined);
const skipReason = missing.length > 0 ? ` [skipped: ${missing.join('; ')}]` : '';
if (skipReason) console.warn(`node-compat guest e2e${skipReason}`);

/**
 * The guest calls the overlays with the arguments the u64 fixes are about, so a value
 * that is not a BigInt or safe integer would trap the real canonical-ABI lowering.
 */
const APP = `import { getRandomValues, randomBytes, randomFillSync } from 'node:crypto';
import * as fs from 'node:fs';

function attempt(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

export default async (): Promise<Response> => {
  const out: Record<string, unknown> = {};
  out.chunked = (randomBytes(70_000) as Uint8Array).length;
  out.fractional = (randomBytes(1.5) as Uint8Array).length;
  out.cap = attempt(() => randomBytes(2 ** 31));
  out.fill = randomFillSync(new Uint8Array(8), 2, 4).length;
  out.fillOffset = attempt(() => randomFillSync(new Uint8Array(2), 4));
  out.values = getRandomValues(new Uint32Array(4)).length;

  const fd = fs.openSync('/data/probe.txt', 'w+');
  fs.writeSync(fd, 'hello world');
  fs.writeSync(fd, 'J', 0);
  // Not a safe-integer position: Node writes at the current position (11).
  fs.writeSync(fd, new TextEncoder().encode('!'), 0, 1, 1.5);
  fs.writeSync(fd, '?', 99n as unknown as number);
  const buffer = new Uint8Array(5);
  out.read = fs.readSync(fd, buffer, 0, 5, 0);
  out.readText = new TextDecoder().decode(buffer);
  out.readBigInt = fs.readSync(fd, buffer, 0, 5, 6n);
  out.readBigIntText = new TextDecoder().decode(buffer);
  out.readEof = fs.readSync(fd, buffer, 0, 1, 2n ** 60n);
  out.readZero = fs.readSync(fd, buffer, 6, 0, 0);
  out.readRange = attempt(() => fs.readSync(fd, buffer, 0, 1, 1.5));
  fs.closeSync(fd);
  out.file = fs.readFileSync('/data/probe.txt', 'utf8');
  return Response.json(out);
};
`;

describe('node-compat overlays in a real componentize-qjs guest', () => {
  it.skipIf(missing.length > 0)(
    `lowers getRandomBytes and fs.readSync/writeSync u64 arguments under wasmtime${skipReason}`,
    async () => {
      if (wasmtime === undefined || qjs === undefined) throw new Error('unreachable');
      const root = makeProject();
      writeFileSync(join(root, 'src', 'app.ts'), APP);
      const data = mkdtempSync(join(tmpdir(), 'node-compat-guest-data-'));
      mkdirSync(data, { recursive: true });
      const deps = {
        ...DEFAULT_DEPS,
        cwd: () => root,
        assetsDirectory: () => DIST_ASSETS,
        componentizeQjsPath: () => qjs,
      };
      // wasmtime serve cannot link wasi:logging; dev builds for it the same way.
      await buildComponent(loadProject(root), captureIo().io, deps, { guestLogging: false });

      const port = 19000 + Math.floor(Math.random() * 1000);
      const child = Bun.spawn(
        [
          wasmtime,
          'serve',
          '-S',
          'cli',
          '-S',
          'p3',
          '--dir',
          `${data}::/data`,
          '--addr',
          `127.0.0.1:${port}`,
          join(root, 'dist', 'demo-app.wasm'),
        ],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' },
      );
      let body: Record<string, unknown> | undefined;
      let failure = '';
      try {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && body === undefined) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/`);
            const text = await response.text();
            if (response.ok) body = JSON.parse(text) as Record<string, unknown>;
            else failure = `${response.status} ${text}`;
            if (!response.ok) break;
          } catch {
            await DEFAULT_DEPS.wait(200);
          }
        }
      } finally {
        child.kill();
        await child.exited;
      }
      if (body === undefined) {
        const stderr = await new Response(child.stderr).text();
        throw new Error(`guest did not answer: ${failure}\n${stderr}`);
      }
      expect(body).toEqual({
        chunked: 70_000,
        fractional: 1,
        cap: 'ERR_OUT_OF_RANGE',
        fill: 8,
        fillOffset: 'ERR_OUT_OF_RANGE',
        values: 4,
        read: 5,
        readText: 'Jello',
        readBigInt: 5,
        readBigIntText: 'world',
        readEof: 0,
        readZero: 0,
        readRange: 'ERR_OUT_OF_RANGE',
        file: 'Jello world!?',
      });
      expect(readFileSync(join(data, 'probe.txt'), 'utf8')).toBe('Jello world!?');
    },
    180_000,
  );
});
