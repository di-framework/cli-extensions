import type { BindingRecord } from './bindings';

/** Must match `@di-framework/bindings` `WASMCLOUD_GUESTS_GLOBAL`. */
export const WASMCLOUD_GUESTS_GLOBAL = 'di-framework.wasmcloud.guests';

function specifierFor(binding: BindingRecord, iface: string): string {
  if (binding.serviceName && iface !== 'types') return `${binding.name}-${iface}`;
  return `${binding.requirement.package}/${iface}@${binding.requirement.version}`;
}

/**
 * ES module of real WIT guest imports. Evaluating it installs the guests on
 * `globalThis` before the application module runs.
 */
export function renderGuestsModule(bindings: readonly BindingRecord[]): string {
  const lines: string[] = [];
  const specifierIdents = new Map<string, string>();
  const entries: string[] = [];
  let next = 0;

  for (const binding of bindings) {
    const idents: string[] = [];
    for (const iface of binding.requirement.interfaces) {
      // `types` is a shared WIT types package (no funcs). qjs cannot resolve it
      // as a JS module; query/prepared `use` the same types at the WIT layer.
      if (iface === 'types') continue;
      const specifier = specifierFor(binding, iface);
      let ident = specifierIdents.get(specifier);
      if (ident === undefined) {
        ident = `guest${next}`;
        next += 1;
        specifierIdents.set(specifier, ident);
        lines.push(`import * as ${ident} from ${JSON.stringify(specifier)};`);
      }
      idents.push(ident);
    }
    const value =
      idents.length === 0
        ? '{}'
        : idents.length === 1
          ? (idents[0] ?? '{}')
          : `Object.assign({}, ${idents.join(', ')})`;
    entries.push(`  ${JSON.stringify(binding.name)}: ${value},`);
  }

  if (lines.length > 0) lines.push('');
  lines.push('const guests = {');
  lines.push(...entries);
  lines.push('};', '');
  lines.push(
    `globalThis[Symbol.for(${JSON.stringify(WASMCLOUD_GUESTS_GLOBAL)})] = guests;`,
    '',
    'export { guests };',
    '',
  );
  return lines.join('\n');
}

export function emptyGuestsModule(): string {
  return [
    'const guests = {};',
    `globalThis[Symbol.for(${JSON.stringify(WASMCLOUD_GUESTS_GLOBAL)})] = guests;`,
    'export { guests };',
    '',
  ].join('\n');
}
