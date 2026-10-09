import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import ts from 'typescript';
import type { WasmcloudDeps } from './deps';
import { asWitIdentifier, type WasmcloudProject } from './project';
import type { WitRequirement } from './wit';

export type BindingKind =
  | 'Postgres'
  | 'KeyValue'
  | 'Blobstore'
  | 'Messaging'
  | 'Config'
  | 'Secrets'
  | 'OutgoingHttp';

export type CatalogEntry = {
  kind: BindingKind;
  package: string;
  version: string;
  interfaces: string[];
  primaryInterface: string;
  namedInstance: boolean;
  sharedResources: string[];
  witDep: string;
  usesSecret: boolean;
  configKeys: string[];
};

export type BindingCatalog = Record<string, CatalogEntry>;

export type BindingRecord = {
  className: string;
  name: string;
  kind: BindingKind;
  requirement: WitRequirement;
  serviceName?: string;
  secretFrom?: string;
  configFrom?: string;
  config?: Record<string, string>;
};

const BINDING_DECORATOR_NAMES = new Set(['PlatformBinding', 'WasmCloudBinding']);

function importedDecoratorNames(source: ts.SourceFile): Set<string> {
  const names = new Set(BINDING_DECORATOR_NAMES);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause == null) continue;
    const module = stringLiteral(statement.moduleSpecifier);
    if (module !== '@di-framework/bindings') continue;
    const named = statement.importClause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (BINDING_DECORATOR_NAMES.has(imported)) names.add(element.name.text);
    }
  }
  return names;
}

function bindingsFailure(
  code: string,
  message: string,
  details: Record<string, string | number | boolean> = {},
): never {
  throw new CommandFailure(code, message, 2, details);
}

export function defaultSecretName(applicationName: string, bindingName: string): string {
  return `${asWitIdentifier(applicationName)}-${bindingName}`;
}

const SECRET_CONFIG_KEYS = new Set([
  'password',
  'secret',
  'token',
  'uri',
  'url',
  'connectionstring',
  'connection-string',
]);

export function rejectsPlaintextSecret(
  config: Record<string, string> | undefined,
): string | undefined {
  if (config === undefined) return undefined;
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_CONFIG_KEYS.has(key.toLowerCase())) {
      return `config key "${key}" must not carry a secret value; use secretFrom`;
    }
    if (/:\/\//.test(value) || /password=/i.test(value)) {
      return `config value for "${key}" looks like a secret or connection string; use secretFrom`;
    }
  }
  return undefined;
}

export function bindingsPath(project: WasmcloudProject): string | undefined {
  return project.bindingsPath;
}

export function loadBindingCatalog(
  projectRoot: string,
  deps: WasmcloudDeps,
): BindingCatalog | undefined {
  const catalogJson = deps.resolveFromProject(projectRoot, '@di-framework/bindings/catalog.json');
  if (catalogJson !== undefined)
    return JSON.parse(readFileSync(catalogJson, 'utf8')) as BindingCatalog;
  const pkg = deps.resolveFromProject(projectRoot, '@di-framework/bindings');
  if (pkg === undefined) return undefined;
  const candidate = join(dirname(pkg), 'catalog.json');
  if (!existsSync(candidate)) return undefined;
  return JSON.parse(readFileSync(candidate, 'utf8')) as BindingCatalog;
}

function decoratorName(expression: ts.Expression): string | undefined {
  let current = expression;
  while (ts.isCallExpression(current)) current = current.expression;
  if (ts.isIdentifier(current)) return current.text;
  if (!ts.isPropertyAccessExpression(current) || !ts.isIdentifier(current.name)) return undefined;
  return current.name.text;
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
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return undefined;
    const name = property.name.text;
    const value = property.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      result[name] = value.text;
      continue;
    }
    if (ts.isArrayLiteralExpression(value)) {
      const items: string[] = [];
      for (const element of value.elements) {
        const text = stringLiteral(element);
        if (text === undefined) return undefined;
        items.push(text);
      }
      result[name] = items;
      continue;
    }
    if (ts.isObjectLiteralExpression(value)) {
      const nested = objectLiteral(value);
      if (nested === undefined) return undefined;
      result[name] = nested;
      continue;
    }
    return undefined;
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

function importedKinds(source: ts.SourceFile): Map<string, BindingKind> {
  const aliases = new Map<string, BindingKind>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause == null) continue;
    const module = stringLiteral(statement.moduleSpecifier);
    if (module !== '@di-framework/bindings') continue;
    const named = statement.importClause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (
        imported === 'Postgres' ||
        imported === 'KeyValue' ||
        imported === 'Blobstore' ||
        imported === 'Messaging' ||
        imported === 'Config' ||
        imported === 'Secrets' ||
        imported === 'OutgoingHttp'
      ) {
        aliases.set(element.name.text, imported);
      }
    }
  }
  return aliases;
}

export function parseBindingsFile(
  filePath: string,
  catalog: BindingCatalog,
  applicationName: string,
): BindingRecord[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    bindingsFailure(
      'WASMCLOUD_BINDINGS_UNREADABLE',
      `Could not read bindings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { filePath },
    );
  }
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const kinds = importedKinds(source);
  const decoratorNames = importedDecoratorNames(source);
  const records: BindingRecord[] = [];
  const names = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
    const exported =
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;
    if (!exported) continue;

    const heritage = statement.heritageClauses?.find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const superName = heritage?.types[0]?.expression;
    if (superName === undefined || !ts.isIdentifier(superName)) continue;
    const kind = kinds.get(superName.text);
    if (kind === undefined) {
      bindingsFailure(
        'WASMCLOUD_BINDING_UNKNOWN_TYPE',
        `${statement.name.text} extends ${superName.text}, which is not a @di-framework/bindings binding class`,
        { className: statement.name.text, superClass: superName.text },
      );
    }
    const entry = catalog[kind];
    if (entry === undefined) {
      bindingsFailure(
        'WASMCLOUD_BINDING_UNKNOWN_TYPE',
        `No catalog entry for binding class ${kind}`,
        { className: statement.name.text, kind },
      );
    }

    let bindingName: string | undefined;
    let options: {
      interfaces?: string[];
      serviceName?: string;
      secretFrom?: string;
      configFrom?: string;
      config?: Record<string, string>;
    } = {};
    for (const decorator of classDecorators(statement)) {
      if (!ts.isCallExpression(decorator.expression)) continue;
      if (!decoratorNames.has(decoratorName(decorator.expression) ?? '')) continue;
      const [nameArg, optionsArg] = decorator.expression.arguments;
      const name = stringLiteral(nameArg);
      if (name === undefined) {
        bindingsFailure(
          'WASMCLOUD_BINDING_INVALID_NAME',
          `${statement.name.text} @PlatformBinding name must be a string literal`,
          { className: statement.name.text },
        );
      }
      bindingName = name;
      const parsed = objectLiteral(optionsArg);
      if (optionsArg !== undefined && parsed === undefined) {
        bindingsFailure(
          'WASMCLOUD_BINDING_INVALID_OPTIONS',
          `${statement.name.text} @PlatformBinding options must be an object literal of string values`,
          { className: statement.name.text },
        );
      }
      if (parsed !== undefined) {
        if (parsed.serviceName !== undefined && typeof parsed.serviceName !== 'string')
          bindingsFailure(
            'WASMCLOUD_BINDING_INVALID_SERVICE',
            'serviceName must be a string literal',
          );
        if (
          parsed.serviceName !== undefined &&
          ['config', 'configFrom', 'secretFrom'].some((key) => parsed[key] !== undefined)
        )
          bindingsFailure(
            'WASMCLOUD_BINDING_INVALID_OPTIONS',
            'serviceName cannot be combined with manual connection configuration',
          );
        options = {
          interfaces: Array.isArray(parsed.interfaces)
            ? (parsed.interfaces as string[])
            : undefined,
          serviceName: typeof parsed.serviceName === 'string' ? parsed.serviceName : undefined,
          secretFrom: typeof parsed.secretFrom === 'string' ? parsed.secretFrom : undefined,
          configFrom: typeof parsed.configFrom === 'string' ? parsed.configFrom : undefined,
          config:
            parsed.config !== undefined &&
            typeof parsed.config === 'object' &&
            !Array.isArray(parsed.config)
              ? (parsed.config as Record<string, string>)
              : undefined,
        };
        const secretProblem = rejectsPlaintextSecret(options.config);
        if (secretProblem !== undefined) {
          bindingsFailure(
            'WASMCLOUD_BINDING_PLAINTEXT_SECRET',
            `${statement.name.text} @PlatformBinding: ${secretProblem}`,
            { className: statement.name.text, name: bindingName },
          );
        }
      }
    }
    if (bindingName === undefined) {
      bindingsFailure(
        'WASMCLOUD_BINDING_INVALID_NAME',
        `${statement.name.text} must be decorated with @PlatformBinding('name')`,
        { className: statement.name.text },
      );
    }
    if (!/^[a-z][a-z0-9-]*$/.test(bindingName)) {
      bindingsFailure(
        'WASMCLOUD_BINDING_INVALID_NAME',
        `${statement.name.text} binding name "${bindingName}" must be a WIT identifier`,
        { className: statement.name.text, name: bindingName },
      );
    }
    if (names.has(bindingName)) {
      bindingsFailure(
        'WASMCLOUD_BINDING_DUPLICATE_NAME',
        `Duplicate wasmCloud binding name "${bindingName}"`,
        { name: bindingName, className: statement.name.text },
      );
    }
    names.add(bindingName);
    if (options.serviceName !== undefined) {
      if (
        kind !== 'Postgres' ||
        !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(options.serviceName) ||
        options.serviceName.length > 40
      )
        bindingsFailure(
          'WASMCLOUD_BINDING_INVALID_SERVICE',
          'serviceName requires Postgres and a DNS label of at most 40 characters',
        );
      if (bindingName.length > 54 || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(bindingName))
        bindingsFailure(
          'WASMCLOUD_BINDING_INVALID_NAME',
          'Managed PostgreSQL binding names must be DNS labels of at most 54 characters',
        );
    }

    const interfaces = options.interfaces ?? entry.interfaces;
    for (const iface of interfaces) {
      if (!entry.interfaces.includes(iface)) {
        bindingsFailure(
          'WASMCLOUD_BINDING_UNSUPPORTED_INTERFACE',
          `${statement.name.text} requests unsupported interface "${iface}" on ${kind}`,
          { className: statement.name.text, iface, kind },
        );
      }
    }
    if (interfaces.length === 0) {
      bindingsFailure(
        'WASMCLOUD_BINDING_UNSUPPORTED_INTERFACE',
        `${statement.name.text} must declare at least one interface`,
        { className: statement.name.text },
      );
    }

    const ordered = [
      entry.primaryInterface,
      ...interfaces.filter((iface) => iface !== entry.primaryInterface),
    ].filter((iface) => interfaces.includes(iface));

    records.push({
      className: statement.name.text,
      name: bindingName,
      kind,
      requirement: {
        package: entry.package,
        version: entry.version,
        interfaces: ordered,
        direction: 'import',
        instanceName: entry.namedInstance ? bindingName : undefined,
        source: statement.name.text,
      },
      serviceName: options.serviceName,
      secretFrom: options.serviceName
        ? `di-binding-${bindingName}-creds`
        : (options.secretFrom ??
          (entry.usesSecret ? defaultSecretName(applicationName, bindingName) : undefined)),
      configFrom: options.configFrom,
      config: options.config,
    });
  }

  return records;
}

export function discoverBindings(project: WasmcloudProject, deps: WasmcloudDeps): BindingRecord[] {
  const path = project.bindingsPath;
  if (path === undefined) return [];
  if (!existsSync(path)) {
    if (project.bindingsConfigured) {
      bindingsFailure(
        'WASMCLOUD_BINDINGS_NOT_FOUND',
        `bindings "${project.bindingsRelative}" is not readable`,
        { configPath: project.configPath },
      );
    }
    return [];
  }
  const catalog = loadBindingCatalog(project.projectRoot, deps);
  if (catalog === undefined) {
    bindingsFailure(
      'WASMCLOUD_BINDING_CATALOG_MISSING',
      'src/bindings.ts requires @di-framework/bindings in the project',
      { className: path, application: project.applicationName },
    );
  }
  return parseBindingsFile(path, catalog, project.applicationName);
}

export function requirementsFromBindings(bindings: readonly BindingRecord[]): WitRequirement[] {
  return bindings.flatMap((binding): WitRequirement[] => {
    if (!binding.serviceName)
      return [{ ...binding.requirement, interfaces: [...binding.requirement.interfaces] }];
    return binding.requirement.interfaces.map((iface) => ({
      ...binding.requirement,
      interfaces: [iface],
      instanceName: iface === 'types' ? undefined : `${binding.name}-${iface}`,
      namedImport: iface !== 'types',
    }));
  });
}
