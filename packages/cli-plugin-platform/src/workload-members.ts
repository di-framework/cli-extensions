import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import ts from 'typescript';
import type { WasmcloudProject } from './project';

export type WorkloadEntry = {
  kind: 'component' | 'service';
  exportName: string;
  path: string;
  subscriptions?: string[];
};

/** Read declarations without executing application code or resolving host bindings. */
export function discoverWorkloadEntry(entryPath: string, workload: string): WorkloadEntry {
  const source = ts.createSourceFile(
    entryPath,
    readFileSync(entryPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const fail = (message: string): never => {
    throw new CommandFailure('WASMCLOUD_WORKLOAD_INVALID', `${entryPath}: ${message}`, 2);
  };
  const declarations = new Map<string, 'component' | 'service'>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@di-framework/bindings'
    )
      continue;
    const imports = statement.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    for (const imported of imports.elements) {
      const name = imported.propertyName?.text ?? imported.name.text;
      if (name === 'WorkloadComponent') declarations.set(imported.name.text, 'component');
      if (name === 'WorkloadService') declarations.set(imported.name.text, 'service');
    }
  }
  const entries: WorkloadEntry[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      const wrapper = declaration.initializer;
      if (
        !ts.isIdentifier(declaration.name) ||
        !wrapper ||
        !ts.isCallExpression(wrapper) ||
        !ts.isCallExpression(wrapper.expression) ||
        !ts.isIdentifier(wrapper.expression.expression)
      )
        continue;
      const kind = declarations.get(wrapper.expression.expression.text);
      if (!kind) continue;
      const options = wrapper.expression.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options))
        fail('workload options must be an object literal');
      const entry: WorkloadEntry = { kind, exportName: declaration.name.text, path: '' };
      for (const property of (options as ts.ObjectLiteralExpression).properties) {
        if (!ts.isPropertyAssignment(property)) fail('workload options must be static properties');
        const assignment = property as ts.PropertyAssignment;
        const name = assignment.name.getText(source).replace(/^['"]|['"]$/g, '');
        const value = assignment.initializer;
        if (name === 'workload') {
          if (!ts.isStringLiteral(value) || value.text !== workload)
            fail('source workload must match di-framework.config.json');
        } else if (name === 'path') {
          if (
            !ts.isStringLiteral(value) ||
            !value.text.startsWith('/') ||
            value.text.startsWith('//') ||
            /[\s?#\\]/.test(value.text)
          )
            fail('member path must be a literal absolute path');
          entry.path = (value as ts.StringLiteral).text;
        } else if (name === 'subscriptions') {
          if (
            kind !== 'service' ||
            !ts.isArrayLiteralExpression(value) ||
            value.elements.length === 0 ||
            value.elements.some(
              (v) => !ts.isStringLiteral(v) || !v.text.trim() || /[\s,]/.test(v.text),
            )
          )
            fail('service subscriptions must be a nonempty array of literal subjects');
          entry.subscriptions = (value as ts.ArrayLiteralExpression).elements.map(
            (v) => (v as ts.StringLiteral).text,
          );
        } else fail(`unsupported workload option ${name}`);
      }
      if (!entry.path) fail('components and services must declare a path');
      entries.push(entry);
    }
  }
  if (entries.length !== 1)
    fail('declare exactly one exported WorkloadComponent or WorkloadService in the entry module');
  return entries[0] ?? fail('workload entry is missing');
}

/** An inferred description, never an application project or source composition file. */
export function writeWorkloadManifest(
  root: string,
  name: string,
  projects: Iterable<WasmcloudProject>,
): string {
  const members = [...projects]
    .filter((p) => p.workload === name)
    .sort((a, b) => a.applicationName.localeCompare(b.applicationName));
  const paths = new Map<string, string>();
  const routes = new Map<string, string>();
  for (const member of members) {
    const entry = member.workloadEntry;
    if (!entry) continue;
    const path = entry.path;
    const previous = paths.get(path);
    if (previous)
      throw new CommandFailure(
        'WASMCLOUD_WORKLOAD_PATH_CONFLICT',
        `${name}: ${previous} and ${member.applicationName} both claim ${path}`,
        2,
      );
    paths.set(path, member.applicationName);
    if (entry.kind === 'component') routes.set(path, member.applicationName);
  }
  const path = join(root, '.di-framework', 'workloads', `${name}.json`);
  mkdirSync(join(root, '.di-framework', 'workloads'), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name,
        members: members.map((p) => ({
          name: p.applicationName,
          project: relative(root, p.projectRoot),
          entry: relative(p.projectRoot, p.entryPath),
          ...p.workloadEntry,
        })),
        paths: Object.fromEntries(paths),
        routes: Object.fromEntries(routes),
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

export function renderWorkloadServiceAdapter(entry: WorkloadEntry): string {
  const header = `import 'virtual:di-framework-wasmcloud-guests';\nimport { ${entry.exportName} as invoke } from 'virtual:di-framework-application';\n`;
  if (entry.subscriptions) {
    return `${header}export const handler = {
  async handleMessage(message) {
    try { await invoke(message); }
    catch (error) {
      if (error && ['reject', 'retry', 'other'].includes(error.tag)) throw error;
      console.error('Workload message handler failed', error);
      throw { tag: 'retry' };
    }
  }
};\n`;
  }
  return `${header}export const run = { async run() { await invoke(); } };\n`;
}
