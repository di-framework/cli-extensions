import * as fs from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ActorRuntime } from '@di-framework/actors';
import ts from 'typescript';
import { ALWAYS_SKIP_DIRECTORIES } from './manifest';
import type { WasmcloudProject } from './project';

export const WASMCLOUD_ACTORS_GLOBAL = 'di-framework.wasmcloud.actors';

import { ACTORS_INVOCATION_PATH, handleActorInvocationRequest } from './actor-protocol';

export {
  ACTORS_INVOCATION_PATH,
  handleActorInvocationRequest,
  isActorInvocationRequest,
} from './actor-protocol';

export interface ActorMethodRecord {
  name: string;
  methodName: string;
  timeout?: number;
}

export interface ActorDiscoveredRecord {
  className: string;
  actorName: string;
  namespace: string;
  filePath: string;
  importPath: string;
  methods: ActorMethodRecord[];
  hasMigrations: boolean;
}

export interface ActorModuleOptions {
  defaultStorageDir?: string;
}

export interface WasmcloudActorAdapter {
  handle(request: Request): Promise<Response>;
  invoke(actorType: string, actorKey: string, method: string, args?: unknown[]): Promise<unknown>;
  dispatchActorInvocation(
    actorType: string,
    actorKey: string,
    method: string,
    args?: unknown[],
  ): Promise<unknown>;
  actorRuntime: ActorRuntime;
}

export function createWasmcloudActorAdapter(actorRuntime: ActorRuntime): WasmcloudActorAdapter {
  const dispatchActorInvocation = async (
    actorType: string,
    actorKey: string,
    method: string,
    args: unknown[] = [],
  ) => {
    return await actorRuntime.invoke(actorType, actorKey, method, args);
  };

  const handle = async (request: Request): Promise<Response> => {
    // Prefer the local dispatch path so mailbox serialization is preserved.
    // HTTP adapters that need RPC deadline/auth semantics pass runtime without dispatchFn.
    return await handleActorInvocationRequest(request, undefined, dispatchActorInvocation);
  };

  const invoke = async (
    actorType: string,
    actorKey: string,
    method: string,
    args: unknown[] = [],
  ): Promise<unknown> => {
    const request = new Request(`http://localhost${ACTORS_INVOCATION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorType, actorKey, method, args }),
    });
    const response = await handle(request);
    const data = await response.json();
    if (!response.ok || !data.success) {
      const err = new Error(data.error?.message ?? 'Actor invocation failed');
      err.name = data.error?.name ?? 'Error';
      Object.assign(err, data.error);
      throw err;
    }
    return data.result;
  };

  return {
    handle,
    invoke,
    dispatchActorInvocation,
    actorRuntime,
  };
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function objectLiteral(node: ts.Expression | undefined): Record<string, unknown> | undefined {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
  const result: Record<string, unknown> = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    const name = property.name.text;
    const value = property.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      result[name] = value.text;
    } else if (ts.isNumericLiteral(value)) {
      result[name] = Number(value.text);
    } else if (value.kind === ts.SyntaxKind.TrueKeyword) {
      result[name] = true;
    } else if (value.kind === ts.SyntaxKind.FalseKeyword) {
      result[name] = false;
    } else if (ts.isArrayLiteralExpression(value)) {
      result[name] = value.elements.map((el) => stringLiteral(el) ?? true);
    }
  }
  return result;
}

function classDecorators(node: ts.ClassDeclaration): readonly ts.Decorator[] {
  const fromModifiers = (node.modifiers ?? []).filter((modifier) =>
    ts.isDecorator(modifier),
  ) as ts.Decorator[];
  const legacy = (node as ts.ClassDeclaration & { decorators?: readonly ts.Decorator[] })
    .decorators;
  return [...fromModifiers, ...(legacy ?? [])];
}

function methodDecorators(node: ts.MethodDeclaration): readonly ts.Decorator[] {
  const fromModifiers = (node.modifiers ?? []).filter((modifier) =>
    ts.isDecorator(modifier),
  ) as ts.Decorator[];
  const legacy = (node as ts.MethodDeclaration & { decorators?: readonly ts.Decorator[] })
    .decorators;
  return [...fromModifiers, ...(legacy ?? [])];
}

function parseActorFile(filePath: string, projectRoot: string): ActorDiscoveredRecord[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  // Quick heuristic before AST parsing
  if (!content.includes('Actor') && !content.includes('@di-framework/actors')) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );

  const records: ActorDiscoveredRecord[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;

    const className = statement.name.text;
    let isActor = false;
    let actorName = className;
    let namespace = 'default';
    let hasMigrations = false;

    for (const decorator of classDecorators(statement)) {
      const expr = decorator.expression;
      let decName: string | undefined;

      if (ts.isIdentifier(expr)) {
        decName = expr.text;
      } else if (ts.isCallExpression(expr)) {
        if (ts.isIdentifier(expr.expression)) {
          decName = expr.expression.text;
        } else if (ts.isPropertyAccessExpression(expr.expression)) {
          decName = expr.expression.name.text;
        }

        if (decName === 'Actor') {
          const arg = expr.arguments[0];
          if (arg) {
            const str = stringLiteral(arg);
            if (str) {
              actorName = str;
            } else {
              const obj = objectLiteral(arg);
              if (obj) {
                if (typeof obj.name === 'string') actorName = obj.name;
                if (typeof obj.namespace === 'string') namespace = obj.namespace;
                if (obj.migrations) hasMigrations = true;
              }
            }
          }
        }
      }

      if (decName === 'Actor') {
        isActor = true;
      }
    }

    if (!isActor) continue;

    // Scan methods
    const methods: ActorMethodRecord[] = [];
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name))
        continue;

      const methodName = member.name.text;
      let isActorMethod = false;
      let exposedName = methodName;
      let timeout: number | undefined;

      for (const dec of methodDecorators(member)) {
        const expr = dec.expression;
        let decName: string | undefined;

        if (ts.isIdentifier(expr)) {
          decName = expr.text;
        } else if (ts.isCallExpression(expr)) {
          if (ts.isIdentifier(expr.expression)) {
            decName = expr.expression.text;
          } else if (ts.isPropertyAccessExpression(expr.expression)) {
            decName = expr.expression.name.text;
          }

          if (decName === 'ActorMethod') {
            const arg = expr.arguments[0];
            if (arg) {
              const str = stringLiteral(arg);
              if (str) {
                exposedName = str;
              } else {
                const obj = objectLiteral(arg);
                if (obj) {
                  if (typeof obj.name === 'string') exposedName = obj.name;
                  if (typeof obj.timeout === 'number') timeout = obj.timeout;
                }
              }
            }
          }
        }

        if (decName === 'ActorMethod') {
          isActorMethod = true;
        }
      }

      if (isActorMethod) {
        methods.push({ name: exposedName, methodName, timeout });
      }
    }

    // Relative import path from .di-framework/ to the source file
    const generatedDir = join(projectRoot, '.di-framework');
    let relPath = relative(generatedDir, filePath).split(sep).join('/');
    if (!relPath.startsWith('.')) {
      relPath = `./${relPath}`;
    }

    records.push({
      className,
      actorName,
      namespace,
      filePath,
      importPath: relPath,
      methods,
      hasMigrations,
    });
  }

  return records;
}

export function discoverActors(project: WasmcloudProject): ActorDiscoveredRecord[] {
  const root = project.projectRoot;
  const actors: ActorDiscoveredRecord[] = [];
  const visited = new Set<string>();

  const scanDir = (dir: string) => {
    if (visited.has(dir)) return;
    visited.add(dir);

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          ALWAYS_SKIP_DIRECTORIES.has(entry.name) ||
          entry.name === 'dist' ||
          entry.name === '.di-framework'
        ) {
          continue;
        }
        scanDir(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        if (
          entry.name.endsWith('.d.ts') ||
          entry.name.endsWith('.test.ts') ||
          entry.name.endsWith('.spec.ts')
        ) {
          continue;
        }
        const fileActors = parseActorFile(fullPath, root);
        actors.push(...fileActors);
      }
    }
  };

  // Check entry directory and src/
  const srcDir = join(root, 'src');
  if (fs.existsSync(srcDir)) {
    scanDir(srcDir);
  } else {
    scanDir(root);
  }

  // Also check entryPath directly if not visited
  if (fs.existsSync(project.entryPath) && !actors.some((a) => a.filePath === project.entryPath)) {
    const fileActors = parseActorFile(project.entryPath, root);
    actors.push(...fileActors);
  }

  return actors;
}

export function renderActorsModule(
  actors: readonly ActorDiscoveredRecord[],
  options: ActorModuleOptions = {},
): string {
  const lines: string[] = [];

  lines.push("import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';");

  const importedClassNames: string[] = [];
  for (const actor of actors) {
    importedClassNames.push(actor.className);
    lines.push(`import { ${actor.className} } from ${JSON.stringify(actor.importPath)};`);
  }

  lines.push('');
  const defaultDir = options.defaultStorageDir ?? './.actors';
  lines.push(
    `const defaultStorageDir = ${JSON.stringify(defaultDir)};`,
    'let storage;',
    'let runtime;',
    '',
    'function resolveStorageDir() {',
    '  return process.env.ACTOR_STORAGE_DIR || process.env.DI_STORAGE_DIR || defaultStorageDir;',
    '}',
    '',
    'function ensureActorRuntime() {',
    '  if (runtime) return runtime;',
    '  // WASI VFS has no file locking; exclusive ownership is enforced by replicas: 1.',
    '  // Defer until first use so WASI environment (ACTOR_STORAGE_DIR) is available.',
    '  storage = new SqliteActorStorage({ baseDir: resolveStorageDir(), fileLocking: false });',
    '  runtime = new ActorRuntime({ storage });',
  );

  for (const actor of actors) {
    lines.push(
      `  runtime.register(${actor.className}, {`,
      `    name: ${JSON.stringify(actor.actorName)},`,
      `    namespace: ${JSON.stringify(actor.namespace)},`,
      '  });',
    );
  }

  lines.push(
    '  return runtime;',
    '}',
    '',
    'export async function dispatchActorInvocation(actorType, actorKey, method, args = []) {',
    '  return await ensureActorRuntime().invoke(actorType, actorKey, method, args);',
    '}',
    '',
    'export function getActorRuntime() { return ensureActorRuntime(); }',
    'export { getActorRuntime as actorRuntime, storage };',
    `export { ${importedClassNames.join(', ')} };`,
    '',
    `globalThis[Symbol.for(${JSON.stringify(WASMCLOUD_ACTORS_GLOBAL)})] = {`,
    '  get actorRuntime() { return ensureActorRuntime(); },',
    '  dispatchActorInvocation,',
    '  actors: [',
  );

  for (const actor of actors) {
    lines.push(
      `    { className: ${JSON.stringify(actor.className)}, actorName: ${JSON.stringify(actor.actorName)}, namespace: ${JSON.stringify(actor.namespace)} },`,
    );
  }

  lines.push('  ],', '};', '');

  return lines.join('\n');
}

export function emptyActorsModule(): string {
  return [
    'export const actorRuntime = undefined;',
    'export function getActorRuntime() { return undefined; }',
    'export const dispatchActorInvocation = undefined;',
    'export const actors = [];',
    `globalThis[Symbol.for(${JSON.stringify(WASMCLOUD_ACTORS_GLOBAL)})] = { actors: [] };`,
    '',
  ].join('\n');
}
