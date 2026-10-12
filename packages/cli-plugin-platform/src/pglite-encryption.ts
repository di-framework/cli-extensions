/**
 * Wiring a PGlite encryption layer between the provider and the host filesystem.
 *
 * `wac plug` is best effort: it plugs each export of the layer whose name matches an import of
 * the provider *and* whose type is a subtype of it, silently skips the rest, and exits 0 as soon
 * as one pair plugged. A layer that exports only `wasi:cli/environment`, exports the filesystem
 * at a version wac does not match, or exports it with a different type would compose cleanly and
 * leave PGlite writing plaintext to the host. So the build does not use `wac plug` here: it
 * plans the wiring itself and composes an explicit WAC document with `wac compose`, where every
 * provider import that must go to the layer is a named instantiation argument. wac then
 * type-checks each one and fails loudly instead of skipping it.
 */

/** An interface a component's world imports or exports, e.g. `wasi:filesystem/types@0.2.9`. */
export type WitInterface = { name: string; version?: string };

const FILESYSTEM = 'wasi:filesystem/';
const WORLD_ITEM =
  /^\s*(import|export)\s+([a-z][a-z0-9-]*:[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)(?:@([^;\s]+))?;\s*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const WORLD_LINE = /^\s*(import|export)\s/;

/**
 * The interfaces a component's world imports and exports, from `jco wit` output. `unrecognized`
 * holds every other `import`/`export` line, such as a plain-named `import fs: interface {` or a
 * bare function, which the wiring cannot reason about.
 */
export function worldInterfaces(wit: string): {
  imports: WitInterface[];
  exports: WitInterface[];
  unrecognized: string[];
} {
  const imports: WitInterface[] = [];
  const exports: WitInterface[] = [];
  const unrecognized: string[] = [];
  for (const line of wit.split('\n')) {
    const match = WORLD_ITEM.exec(line);
    if (match === null) {
      if (WORLD_LINE.test(line)) unrecognized.push(line.trim());
      continue;
    }
    const item = {
      name: match[2] as string,
      ...(match[3] === undefined ? {} : { version: match[3] }),
    };
    (match[1] === 'import' ? imports : exports).push(item);
  }
  return { imports, exports, unrecognized };
}

/**
 * Interfaces the provider may take straight from the host. Everything else it imports must be
 * wired to the layer, so a provider that reached storage some other way (another filesystem
 * package, a plain-named interface) stops the build instead of bypassing the layer.
 */
export const HOST_PASS_THROUGH = ['wasi:io/', 'wasi:clocks/', 'wasi:random/', 'wasi:cli/'];

export function formatInterface(item: WitInterface): string {
  return item.version === undefined ? item.name : `${item.name}@${item.version}`;
}

/**
 * Whether two versions of an interface are on the same semver track, as wac decides it
 * (wac-types `are_semver_compatible`), in either direction: the same major from 1.0 on, the
 * same minor for 0.x with x ≥ 1, and an exact match for 0.0.z and pre-releases. Unversioned
 * names match only each other.
 */
export function semverCompatible(a?: string, b?: string): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (x === null || y === null || x[4] !== undefined || y[4] !== undefined) return false;
  const [xMajor, xMinor, xPatch] = [1, 2, 3].map((n) => Number(x[n]));
  const [yMajor, yMinor, yPatch] = [1, 2, 3].map((n) => Number(y[n]));
  if (xMajor !== yMajor) return false;
  if (xMajor !== 0) return true;
  if (xMinor !== yMinor) return false;
  if (xMinor !== 0) return true;
  return xPatch === yPatch;
}

const isFilesystem = (item: WitInterface) => item.name.startsWith(FILESYSTEM);

/** One provider import wired to one layer export, by their full names. */
export type Wire = { providerImport: string; layerExport: string };

/**
 * Which layer export each provider import is wired to: the export with the same name and
 * version, else the first on the same semver track (wac's own matching). Every
 * `wasi:filesystem/*` import must be wired, or `problem` says why not; other interfaces the
 * layer re-exports (`wasi:io/streams`, `wasi:cli/*`, …) are wired too, since the filesystem
 * types refer to them.
 */
export function planWiring(
  provider: { imports: WitInterface[]; exports?: WitInterface[]; unrecognized?: string[] },
  layer: { exports: WitInterface[] },
): { wires: Wire[]; problem?: string } {
  if (provider.unrecognized !== undefined && provider.unrecognized.length > 0)
    return {
      wires: [],
      problem: `the provider's world has items the build cannot wire: ${provider.unrecognized.join('; ')}`,
    };
  const required = provider.imports.filter(isFilesystem);
  if (required.length === 0)
    return {
      wires: [],
      problem:
        'the provider imports no wasi:filesystem interface, so there is nothing for the layer to encrypt',
    };
  const wires: Wire[] = [];
  const missing: string[] = [];
  for (const wanted of provider.imports) {
    const offered =
      layer.exports.find((item) => item.name === wanted.name && item.version === wanted.version) ??
      layer.exports.find(
        (item) => item.name === wanted.name && semverCompatible(item.version, wanted.version),
      );
    if (offered !== undefined) {
      wires.push({
        providerImport: formatInterface(wanted),
        layerExport: formatInterface(offered),
      });
      continue;
    }
    if (!isFilesystem(wanted)) {
      if (!HOST_PASS_THROUGH.some((prefix) => wanted.name.startsWith(prefix)))
        missing.push(
          `${formatInterface(wanted)} (neither exported by the layer nor allowed from the host)`,
        );
      continue;
    }
    const found = layer.exports
      .filter((item) => item.name === wanted.name)
      .map((item) => `@${item.version ?? 'unversioned'}`);
    const detail = found.length === 0 ? 'not exported' : `the layer exports ${found.join(', ')}`;
    missing.push(`${formatInterface(wanted)} (${detail})`);
  }
  return missing.length === 0
    ? { wires }
    : {
        wires,
        problem: `the layer does not export what the provider imports: ${missing.join('; ')}`,
      };
}

/** WAC package names the composition document refers to (bound with `wac compose --dep`). */
export const LAYER_PACKAGE = 'pglite:layer';
export const PROVIDER_PACKAGE = 'pglite:provider';

/**
 * The WAC document that instantiates the layer against the host and the provider with every
 * wired import taken from the layer's instance, re-exporting the provider's exports. Imports of
 * either that are not wired stay imports of the result (`...`).
 */
export function encryptionComposition(
  wires: readonly Wire[],
  providerExports: WitInterface[],
): string {
  const quote = (name: string) => JSON.stringify(name);
  return [
    'package di-framework:pglite-encrypted;',
    '',
    `let layer = new ${LAYER_PACKAGE} { ... };`,
    `let provider = new ${PROVIDER_PACKAGE} {`,
    ...wires.map((wire) => `  ${quote(wire.providerImport)}: layer[${quote(wire.layerExport)}],`),
    '  ...',
    '};',
    '',
    ...providerExports.map((item) => `export provider[${quote(formatInterface(item))}];`),
    '',
  ].join('\n');
}

/** Custom section the platform's encryption layer carries (`format=1 codec=aes-256-xts`). */
export const ENCFS_SECTION = 'di-framework:pglite-encfs';

/**
 * The contents of the `di-framework:pglite-encfs` custom section anywhere in a core module or
 * component binary, including nested modules and components, or undefined when there is none.
 */
export function encfsSection(bytes: Uint8Array): string | undefined {
  const decoder = new TextDecoder();
  const walk = (start: number, end: number): string | undefined => {
    if (end - start < 8 || bytes[start] !== 0 || bytes[start + 1] !== 0x61) return undefined;
    const component = bytes[start + 6] === 1;
    let offset = start + 8;
    const leb = (): number => {
      let result = 0;
      let shift = 0;
      for (;;) {
        const byte = bytes[offset++] as number;
        result += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0 || offset >= end) return result;
        shift += 7;
      }
    };
    while (offset < end) {
      const id = bytes[offset++] as number;
      const size = leb();
      const body = offset;
      const next = Math.min(end, body + size);
      if (id === 0) {
        offset = body;
        const length = leb();
        const name = decoder.decode(bytes.subarray(offset, offset + length));
        if (name === ENCFS_SECTION) return decoder.decode(bytes.subarray(offset + length, next));
      } else if (component && (id === 1 || id === 4)) {
        const found = walk(body, next);
        if (found !== undefined) return found;
      }
      offset = next;
    }
    return undefined;
  };
  return walk(0, bytes.length);
}
