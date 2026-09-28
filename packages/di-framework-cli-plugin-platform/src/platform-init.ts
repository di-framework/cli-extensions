import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { type CliIo, CommandFailure, type CommandResult } from '@di-framework/cli-extension';
import { parsePlatformInitArgs } from './args';
import { DEFAULT_DEPS, type WasmcloudDeps } from './deps';
import { DEPLOY_MANIFEST_NAME, findDeployManifest } from './manifest';
import { parseToml, TomlParseError } from './toml';

export const LOCAL_PLATFORM_PATH = 'deploy/platform';
export const LOCAL_TARGET_NAME = 'local';
export const LOCAL_STACK_NAME = 'dev';
export const PLATFORM_START_COMMAND = 'di-framework platform cluster up local --yes';
export const PLATFORM_PROJECT_TOKEN = '{{DI_FRAMEWORK_PLATFORM_PROJECT}}';

const LOCAL_TARGET_FIELDS = {
  platform: LOCAL_PLATFORM_PATH,
  stack: LOCAL_STACK_NAME,
} as const;

export async function runWasmcloudPlatformInit(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const { force } = parsePlatformInitArgs(args);
  const workspaceRoot = resolveWorkspaceRoot(deps.cwd());
  const templateRoot = join(deps.assetsDirectory(), 'platform');
  if (
    !existsSync(join(templateRoot, 'Pulumi.yaml')) &&
    !existsSync(join(templateRoot, 'Pulumi.yaml.tmpl'))
  ) {
    throw new CommandFailure(
      'WASMCLOUD_PLATFORM_TEMPLATE_NOT_FOUND',
      `wasmCloud platform templates were not found at ${templateRoot}. Rebuild @di-framework/cli-plugin-platform so dist/assets/platform is installed.`,
      3,
      { templateRoot },
    );
  }

  const platformRoot = join(workspaceRoot, ...LOCAL_PLATFORM_PATH.split('/'));
  mkdirSync(platformRoot, { recursive: true });
  io.stdout.write(`Initializing local wasmCloud platform in ${platformRoot}\n`);

  const written: string[] = [];
  const skipped: string[] = [];
  const platformProject = createPlatformProjectName(workspaceRoot);
  for (const relativePath of listTemplateFiles(templateRoot)) {
    const destination = join(platformRoot, ...destinationRelativePath(relativePath).split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    const content = renderTemplate(
      readFileSync(join(templateRoot, ...relativePath.split('/'))),
      platformProject,
    );
    const writtenName = destinationRelativePath(relativePath);
    if (writeFilePreserving(destination, content, force, io)) written.push(writtenName);
    else skipped.push(writtenName);
  }

  const manifestPath = join(workspaceRoot, DEPLOY_MANIFEST_NAME);
  const manifest = updateDeployManifest(manifestPath, force, io);
  if (manifest.written) written.push(DEPLOY_MANIFEST_NAME);
  else skipped.push(DEPLOY_MANIFEST_NAME);

  io.stdout.write(`\nNext:\n  ${PLATFORM_START_COMMAND}\n`);

  return {
    data: {
      workspaceRoot,
      platformRoot,
      manifestPath,
      defaultTarget: LOCAL_TARGET_NAME,
      target: LOCAL_TARGET_NAME,
      force,
      written,
      skipped,
      startCommand: PLATFORM_START_COMMAND,
    },
    text: `Initialized local platform at ${LOCAL_PLATFORM_PATH}. Start it with:\n${PLATFORM_START_COMMAND}`,
  };
}

export function createPlatformProjectName(workspaceRoot: string): string {
  const normalized = basename(workspaceRoot)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  const slug = normalized.split('-').filter(Boolean).join('-').slice(0, 28);
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 10);
  return `di-framework-wasmcloud-${slug || 'workspace'}-${hash}`;
}

function renderTemplate(content: Buffer, platformProject: string): Buffer {
  const source = content.toString('utf8');
  const platformVersion = (
    createRequire(import.meta.url)('@di-framework/platform/package.json') as { version: string }
  ).version;
  return Buffer.from(
    source
      .replaceAll(PLATFORM_PROJECT_TOKEN, platformProject)
      .replaceAll('{{DI_FRAMEWORK_PLATFORM_VERSION}}', platformVersion),
  );
}

export function resolveWorkspaceRoot(startDirectory: string): string {
  const manifestPath = findDeployManifest(startDirectory);
  return manifestPath === undefined ? startDirectory : dirname(manifestPath);
}

export function destinationRelativePath(relativePath: string): string {
  return relativePath.endsWith('.tmpl') ? relativePath.slice(0, -'.tmpl'.length) : relativePath;
}

export function listTemplateFiles(templateRoot: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      files.push(relative(templateRoot, fullPath).split(sep).join('/'));
    }
  };
  walk(templateRoot);
  return files.sort();
}

function writeFilePreserving(
  path: string,
  content: string | Buffer,
  force: boolean,
  io: CliIo,
): boolean {
  if (force) {
    writeFileSync(path, content);
    io.stdout.write(`  write ${path}\n`);
    return true;
  }
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    try {
      writeSync(fd, Buffer.isBuffer(content) ? content : Buffer.from(content));
    } finally {
      closeSync(fd);
    }
    io.stdout.write(`  write ${path}\n`);
    return true;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      io.stdout.write(`  skip  ${path} (exists; use --force to overwrite)\n`);
      return false;
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function updateDeployManifest(
  manifestPath: string,
  force: boolean,
  io: CliIo,
): { written: boolean } {
  let source: string;
  try {
    source = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    const created = writeFilePreserving(manifestPath, canonicalManifest(), false, io);
    return { written: created };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(source);
  } catch (error) {
    const line = error instanceof TomlParseError ? error.line : undefined;
    throw new CommandFailure(
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      `Could not parse ${manifestPath}${line === undefined ? '' : ` (line ${line})`}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      2,
      { manifestPath, ...(line === undefined ? {} : { line }) },
    );
  }

  if ('apps' in parsed) {
    throw new CommandFailure(
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      `${DEPLOY_MANIFEST_NAME} must not declare "apps"; project identity comes only from di-framework.config.json`,
      2,
      { manifestPath },
    );
  }

  const desired = mergeLocalTarget(parsed, force);
  if (desired.unchanged) {
    io.stdout.write(`  skip  ${manifestPath} (exists; use --force to overwrite)\n`);
    return { written: false };
  }

  rewriteFile(manifestPath, serializeDeployToml(desired.document));
  io.stdout.write(`  write ${manifestPath}\n`);
  return { written: true };
}

function rewriteFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function mergeLocalTarget(
  parsed: Record<string, unknown>,
  force: boolean,
): { document: Record<string, unknown>; unchanged: boolean } {
  const targets = isRecord(parsed.targets) ? { ...parsed.targets } : {};
  const existing = targets[LOCAL_TARGET_NAME];
  const localMatches =
    isRecord(existing) &&
    existing.platform === LOCAL_TARGET_FIELDS.platform &&
    existing.stack === LOCAL_TARGET_FIELDS.stack &&
    Object.keys(existing).every((key) => key === 'platform' || key === 'stack');

  if (!force && existing !== undefined && !localMatches) {
    return { document: parsed, unchanged: true };
  }

  const document: Record<string, unknown> = { ...parsed, targets };
  let changed = false;

  if (force || existing === undefined) {
    if (!localMatches) {
      targets[LOCAL_TARGET_NAME] = { ...LOCAL_TARGET_FIELDS };
      changed = true;
    }
  }

  if (force || parsed['default-target'] === undefined) {
    if (document['default-target'] !== LOCAL_TARGET_NAME) {
      document['default-target'] = LOCAL_TARGET_NAME;
      changed = true;
    }
  }

  return { document, unchanged: !changed };
}

function canonicalManifest(): string {
  return serializeDeployToml({
    'default-target': LOCAL_TARGET_NAME,
    targets: { [LOCAL_TARGET_NAME]: { ...LOCAL_TARGET_FIELDS } },
  });
}

export function serializeDeployToml(document: Record<string, unknown>): string {
  const lines: string[] = [
    '# Deployment topology only. Project identity comes from each',
    '# di-framework.config.json `name` — this file has no `apps` table.',
  ];
  if (typeof document['default-target'] === 'string') {
    lines.push(`default-target = ${tomlString(document['default-target'])}`);
  }

  if (isRecord(document.discovery)) {
    lines.push('', '[discovery]');
    emitTableFields(lines, document.discovery);
  }

  const targets = isRecord(document.targets) ? document.targets : {};
  for (const name of Object.keys(targets).sort(localFirst)) {
    const table = targets[name];
    if (!isRecord(table)) continue;
    lines.push('', `[targets.${name}]`);
    emitTableFields(lines, table);
    emitNestedTables(lines, `targets.${name}`, table);
  }

  lines.push('');
  return `${lines.join('\n')}`;
}

function localFirst(left: string, right: string): number {
  if (left === LOCAL_TARGET_NAME) return -1;
  if (right === LOCAL_TARGET_NAME) return 1;
  return left.localeCompare(right);
}

function emitTableFields(lines: string[], table: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === 'string') {
      lines.push(`${key} = ${tomlString(value)}`);
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      lines.push(`${key} = [${value.map((entry) => tomlString(entry)).join(', ')}]`);
      continue;
    }
    if (typeof value === 'boolean') lines.push(`${key} = ${value}`);
  }
}

function emitNestedTables(lines: string[], prefix: string, table: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(table)) {
    if (!isRecord(value)) continue;
    const nestedPrefix = `${prefix}.${key}`;
    lines.push('', `[${nestedPrefix}]`);
    emitTableFields(lines, value);
    emitNestedTables(lines, nestedPrefix, value);
  }
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
