/**
 * Checks that a PGlite encryption layer really sits between the provider and the host
 * filesystem. `wac plug` succeeds as soon as any one export of the plug matches an import of the
 * socket, so a layer that exports only `wasi:cli/environment`, or exports the filesystem at an
 * incompatible version, composes cleanly and leaves PGlite writing plaintext to the host.
 */

/** An interface a component's world imports or exports, e.g. `wasi:filesystem/types@0.2.9`. */
export type WitInterface = { name: string; version?: string };

const FILESYSTEM = 'wasi:filesystem/';
const WORLD_ITEM =
  /^\s*(import|export)\s+([a-z][a-z0-9-]*:[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)(?:@([^;\s]+))?;\s*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/** The interfaces a component's world imports and exports, from `jco wit` output. */
export function worldInterfaces(wit: string): { imports: WitInterface[]; exports: WitInterface[] } {
  const imports: WitInterface[] = [];
  const exports: WitInterface[] = [];
  for (const line of wit.split('\n')) {
    const match = WORLD_ITEM.exec(line);
    if (match === null) continue;
    const item = {
      name: match[2] as string,
      ...(match[3] === undefined ? {} : { version: match[3] }),
    };
    (match[1] === 'import' ? imports : exports).push(item);
  }
  return { imports, exports };
}

export function formatInterface(item: WitInterface): string {
  return item.version === undefined ? item.name : `${item.name}@${item.version}`;
}

/**
 * Whether an export at `exported` satisfies an import at `imported`, the way `wac plug` matches
 * them: the same major version (and minor, below 1.0), and not older. Pre-releases and
 * unversioned interfaces must match exactly.
 */
export function versionSatisfies(exported?: string, imported?: string): boolean {
  if (exported === undefined || imported === undefined) return exported === imported;
  const e = SEMVER.exec(exported);
  const i = SEMVER.exec(imported);
  if (e === null || i === null || e[4] !== undefined || i[4] !== undefined)
    return exported === imported;
  const [eMajor, eMinor, ePatch] = [1, 2, 3].map((n) => Number(e[n]));
  const [iMajor, iMinor, iPatch] = [1, 2, 3].map((n) => Number(i[n]));
  if (eMajor !== iMajor) return false;
  if (eMajor === 0) return eMinor === iMinor && (ePatch as number) >= (iPatch as number);
  return (
    (eMinor as number) > (iMinor as number) ||
    (eMinor === iMinor && (ePatch as number) >= (iPatch as number))
  );
}

const isFilesystem = (item: WitInterface) => item.name.startsWith(FILESYSTEM);

/**
 * Why the layer cannot stand in for the provider's filesystem, or undefined when it can: it must
 * export, at a compatible version, every `wasi:filesystem/*` interface the provider imports.
 * When it does, `wac plug` connects every one of them, since it plugs each matching export.
 */
export function layerCoverageProblem(
  provider: { imports: WitInterface[] },
  layer: { exports: WitInterface[] },
): string | undefined {
  const required = provider.imports.filter(isFilesystem);
  if (required.length === 0)
    return 'the provider imports no wasi:filesystem interface, so there is nothing for the layer to encrypt';
  const missing = required.flatMap((wanted) => {
    if (
      layer.exports.some(
        (offered) =>
          offered.name === wanted.name && versionSatisfies(offered.version, wanted.version),
      )
    )
      return [];
    const found = layer.exports
      .filter((offered) => offered.name === wanted.name)
      .map((offered) => `@${offered.version ?? 'unversioned'}`);
    const detail = found.length === 0 ? 'not exported' : `the layer exports ${found.join(', ')}`;
    return [`${formatInterface(wanted)} (${detail})`];
  });
  return missing.length === 0
    ? undefined
    : `the layer does not export what the provider imports: ${missing.join('; ')}`;
}

/**
 * Why the composition did not interpose the layer, or undefined when it did. After the plug, the
 * only filesystem imports left must be the layer's own (its path to the host). Any other
 * `wasi:filesystem` import is one of the provider's that went straight to the host.
 */
export function interpositionProblem(
  composed: { imports: WitInterface[]; exports: WitInterface[] },
  layer: { imports: WitInterface[] },
  providerExports: WitInterface[],
): string | undefined {
  const names = (items: WitInterface[]) => items.filter(isFilesystem).map(formatInterface).sort();
  const left = names(composed.imports);
  const own = names(layer.imports);
  const stray = left.filter((name) => !own.includes(name));
  if (stray.length > 0)
    return `the composed provider still imports ${stray.join(', ')} from the host, which the layer does not import itself`;
  const lost = providerExports
    .map(formatInterface)
    .filter((name) => !composed.exports.some((item) => formatInterface(item) === name));
  if (lost.length > 0) return `the composed provider no longer exports ${lost.join(', ')}`;
  return undefined;
}
