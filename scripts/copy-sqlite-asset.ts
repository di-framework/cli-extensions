import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const destination = join(
  import.meta.dir,
  '../packages/di-framework-cli-plugin-platform/dist/assets/sqlite',
);
const source =
  process.env.DI_FRAMEWORK_SQLITE_DIST ??
  join(import.meta.dir, '../../platform/platform/sqlite-component/dist');
const provider = join(source, 'di-framework-sqlite.wasm');

if (!existsSync(provider)) {
  console.log(`sqlite provider not found at ${provider}; skipping asset copy`);
  process.exit(0);
}

mkdirSync(destination, { recursive: true });
for (const file of readdirSync(source)) {
  copyFileSync(join(source, file), join(destination, file));
}
console.log(`copied sqlite provider from ${source}`);
