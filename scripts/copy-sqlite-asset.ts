import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SQLITE_SOURCE_DIR = join(
  import.meta.dir,
  '../../platform/platform/sqlite-component/dist',
);
export const DEFAULT_SQLITE_DESTINATION_DIR = join(
  import.meta.dir,
  '../packages/cli-plugin-platform/dist/assets/sqlite',
);

export type CopySqliteAssetOptions = {
  env?: NodeJS.ProcessEnv;
  sourceDir?: string;
  destinationDir?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type CopySqliteAssetResult = {
  copied: boolean;
  source: string;
  destination: string;
};

export function copySqliteAsset(options: CopySqliteAssetOptions = {}): CopySqliteAssetResult {
  const env = options.env ?? process.env;
  const destination = options.destinationDir ?? DEFAULT_SQLITE_DESTINATION_DIR;
  const source = options.sourceDir ?? env.DI_FRAMEWORK_SQLITE_DIST ?? DEFAULT_SQLITE_SOURCE_DIR;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const provider = join(source, 'di-framework-sqlite.wasm');

  if (!existsSync(provider)) {
    if (env.DI_FRAMEWORK_SKIP_SQLITE_ASSET === '1') {
      log(
        `sqlite provider not found at ${provider}; skipping asset copy (DI_FRAMEWORK_SKIP_SQLITE_ASSET=1)`,
      );
      return { copied: false, source, destination };
    }
    const message =
      `sqlite provider not found at ${provider}. ` +
      'Build the SQLite component or set DI_FRAMEWORK_SQLITE_DIST to the directory containing di-framework-sqlite.wasm ' +
      '(or set DI_FRAMEWORK_SKIP_SQLITE_ASSET=1 to skip copying the SQLite asset).';
    error(message);
    throw new Error(message);
  }

  mkdirSync(destination, { recursive: true });
  for (const file of readdirSync(source)) {
    copyFileSync(join(source, file), join(destination, file));
  }
  log(`copied sqlite provider from ${source}`);
  return { copied: true, source, destination };
}

if (import.meta.main) {
  try {
    copySqliteAsset();
  } catch {
    process.exit(1);
  }
}
