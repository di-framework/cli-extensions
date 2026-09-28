import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { WasmcloudProject } from './project';

export type DiscoveredQueueHandler = {
  className: string;
  methodName: string;
  queueName: string;
  filePath: string;
  options: {
    maxRetries?: number;
    backoffMs?: number;
    timeoutMs?: number;
    concurrency?: number;
  };
};

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function numericLiteral(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}

function objectOptions(node: ts.Expression | undefined): Record<string, number | undefined> {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return {};
  const result: Record<string, number | undefined> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const name = prop.name.text;
    const val = numericLiteral(prop.initializer);
    if (val !== undefined) {
      result[name] = val;
    }
  }
  return result;
}

function methodDecorators(node: ts.MethodDeclaration): readonly ts.Decorator[] {
  const fromModifiers = (node.modifiers ?? []).filter((modifier) =>
    ts.isDecorator(modifier),
  ) as ts.Decorator[];
  const legacy = (node as ts.MethodDeclaration & { decorators?: readonly ts.Decorator[] })
    .decorators;
  return [...fromModifiers, ...(legacy ?? [])];
}

function findSourceFiles(dir: string, fileList: string[] = []): string[] {
  if (!existsSync(dir)) return fileList;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.di-framework' ||
        entry.name === '.git'
      ) {
        continue;
      }
      findSourceFiles(fullPath, fileList);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.js'))
    ) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

export function parseQueueHandlersInFile(filePath: string): DiscoveredQueueHandler[] {
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  if (!content.includes('QueueHandler')) return [];

  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const handlers: DiscoveredQueueHandler[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node)) {
      const className = node.name ? node.name.text : 'AnonymousService';
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member)) {
          const methodName = member.name && ts.isIdentifier(member.name) ? member.name.text : '';
          for (const decorator of methodDecorators(member)) {
            const expr = decorator.expression;
            if (ts.isCallExpression(expr)) {
              const callTarget = expr.expression;
              const decName = ts.isIdentifier(callTarget)
                ? callTarget.text
                : ts.isPropertyAccessExpression(callTarget) && ts.isIdentifier(callTarget.name)
                  ? callTarget.name.text
                  : undefined;

              if (decName === 'QueueHandler') {
                const queueName = stringLiteral(expr.arguments[0]);
                if (queueName) {
                  const opts = objectOptions(expr.arguments[1]);
                  handlers.push({
                    className,
                    methodName,
                    queueName,
                    filePath,
                    options: {
                      maxRetries: opts.maxRetries,
                      backoffMs: opts.backoffMs,
                      timeoutMs: opts.timeoutMs,
                      concurrency: opts.concurrency,
                    },
                  });
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return handlers;
}

export function discoverQueueHandlers(project: WasmcloudProject): DiscoveredQueueHandler[] {
  const filesToScan = new Set<string>();
  if (existsSync(project.entryPath)) {
    filesToScan.add(project.entryPath);
  }

  const srcDir = join(project.projectRoot, 'src');
  if (existsSync(srcDir)) {
    for (const file of findSourceFiles(srcDir)) {
      filesToScan.add(file);
    }
  }

  for (const file of findSourceFiles(project.projectRoot)) {
    filesToScan.add(file);
  }

  const allHandlers: DiscoveredQueueHandler[] = [];
  for (const file of filesToScan) {
    allHandlers.push(...parseQueueHandlersInFile(file));
  }

  // Deduplicate handlers by className + methodName + queueName
  const unique = new Map<string, DiscoveredQueueHandler>();
  for (const h of allHandlers) {
    const key = `${h.className}#${h.methodName}#${h.queueName}`;
    if (!unique.has(key)) {
      unique.set(key, h);
    }
  }

  return [...unique.values()];
}

export function isQueueWorkerProject(
  project: WasmcloudProject,
  queueHandlers: readonly DiscoveredQueueHandler[],
): boolean {
  if (queueHandlers.length === 0) return false;
  if ((project as any).applicationType === 'worker') return true;

  // If there are queue handlers, check if project declares any HTTP controllers
  let hasHttpControllers = false;
  const srcFiles = findSourceFiles(project.projectRoot);
  for (const file of srcFiles) {
    try {
      const code = readFileSync(file, 'utf8');
      if (
        code.includes('@Controller') ||
        code.includes('@Get(') ||
        code.includes('@Post(') ||
        code.includes('@Put(') ||
        code.includes('@Delete(')
      ) {
        hasHttpControllers = true;
        break;
      }
    } catch {
      // ignore
    }
  }

  return !hasHttpControllers;
}
