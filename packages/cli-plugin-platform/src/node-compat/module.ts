type RequireError = Error & { code: string };

function moduleNotFound(specifier: string): RequireError {
  const error = new Error(`Cannot find module '${specifier}'`) as RequireError;
  error.code = 'MODULE_NOT_FOUND';
  return error;
}

export function createRequire(_filename?: string): {
  (specifier: string): unknown;
  resolve(specifier: string): string;
  cache: Record<string, unknown>;
} {
  const require = ((specifier: string) => {
    throw moduleNotFound(specifier);
  }) as unknown as {
    (specifier: string): unknown;
    resolve(specifier: string): string;
    cache: Record<string, unknown>;
  };
  require.resolve = (specifier: string) => {
    throw moduleNotFound(specifier);
  };
  require.cache = Object.create(null) as Record<string, unknown>;
  return require;
}

export const builtinModules = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'crypto',
  'dgram',
  'events',
  'fs',
  'http',
  'module',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'url',
  'util',
];

export default { builtinModules, createRequire };
