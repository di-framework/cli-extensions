import { afterAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DEPS } from '../src/deps';
import { hostInterfacesFromRequirements } from '../src/host-interface';
import { runtimeRequirementsFromJavaScript } from '../src/wit';

type Entry = [string, string, string];
const logged: Entry[] = [];
mock.module('wasi:logging/logging@0.1.0-draft', () => ({
  log: (level: string, context: string, message: string) => logged.push([level, context, message]),
}));

// Importing the module installs the guest console; put the test runner's back afterwards.
const runnerConsole = globalThis.console;
const { CONSOLE_LOG_CONTEXT, createWasiConsole } = await import('../src/node-compat/console');
const installed = globalThis.console;
globalThis.console = runnerConsole;
afterAll(() => {
  globalThis.console = runnerConsole;
});

describe('wasi:logging guest console', () => {
  it('replaces the global console with one that writes through wasi:logging', () => {
    expect(installed).not.toBe(runnerConsole);
    logged.length = 0;
    installed.log('hello', 1);
    expect(logged).toEqual([['info', CONSOLE_LOG_CONTEXT, 'hello 1']]);
  });

  it('maps methods to levels and writes one log call per line', () => {
    const lines: Entry[] = [];
    const guest = createWasiConsole((level, context, message) =>
      lines.push([level, context, message]),
    );
    guest.log('a\nb\n');
    guest.info('info');
    guest.debug('debug');
    guest.trace('trace');
    guest.warn('warn');
    guest.error('first\r\nsecond');
    guest.log('');
    expect(lines).toEqual([
      ['info', 'console', 'a'],
      ['info', 'console', 'b'],
      ['info', 'console', 'info'],
      ['debug', 'console', 'debug'],
      ['trace', 'console', 'trace'],
      ['warn', 'console', 'warn'],
      ['error', 'console', 'first'],
      ['error', 'console', 'second'],
      ['info', 'console', ''],
    ]);
  });

  it('formats errors, objects, and values that cannot be serialized', () => {
    const lines: string[] = [];
    const guest = createWasiConsole((_level, _context, message) => lines.push(message));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bare = new Error('boom');
    bare.stack = undefined;
    guest.log({ topic: 'maps' }, [1, 2], null, undefined, 3n, circular, bare);
    expect(lines).toEqual(['{"topic":"maps"} [1,2] null undefined 3 [object Object] Error: boom']);
    lines.length = 0;
    guest.error(new Error('with stack'));
    expect(lines[0]).toBe('Error: with stack');
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe('guest console linking', () => {
  function writeGuest(): { adapterPath: string; entryPath: string; outFile: string } {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-console-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(entryPath, "console.log('ready');\nexport default {};\n");
    return { adapterPath, entryPath, outFile: join(root, 'dist', 'component.js') };
  }

  it('links wasi:logging by default and declares it as an unnamed host interface', async () => {
    const guest = writeGuest();
    await DEFAULT_DEPS.bundler(guest);
    const source = await Bun.file(guest.outFile).text();
    expect(source).toContain('wasi:logging/logging@0.1.0-draft');
    const requirements = runtimeRequirementsFromJavaScript(source);
    expect(requirements).toContainEqual({
      package: 'wasi:logging',
      version: '0.1.0-draft',
      interfaces: ['logging'],
      direction: 'import',
      source: 'guest-console',
    });
    expect(
      hostInterfacesFromRequirements(
        requirements.filter((requirement) => requirement.package === 'wasi:logging'),
      ),
    ).toEqual([
      { namespace: 'wasi', package: 'logging', version: '0.1.0-draft', interfaces: ['logging'] },
    ]);
  });

  it('leaves wasi:logging out when the runner cannot provide it', async () => {
    const guest = writeGuest();
    await DEFAULT_DEPS.bundler({ ...guest, guestLogging: false });
    const source = await Bun.file(guest.outFile).text();
    expect(source).not.toContain('wasi:logging');
    expect(runtimeRequirementsFromJavaScript(source)).not.toContainEqual(
      expect.objectContaining({ package: 'wasi:logging' }),
    );
  });
});
