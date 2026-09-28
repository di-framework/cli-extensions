import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ALWAYS_SKIP_DIRECTORIES } from './manifest';

export type DiscoveredCronJob = {
  jobId: string;
  kebabId: string;
  className: string;
  methodName: string;
  schedule: string | number;
  cronExpression: string;
  name?: string;
  allowConcurrent: boolean;
  description?: string;
  timeoutMs?: number;
  filePath: string;
};

export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeCronExpression(schedule: string | number): string {
  if (typeof schedule === 'number') {
    const mins = Math.max(1, Math.round(schedule / 60000));
    return mins === 1 ? '* * * * *' : `*/${mins} * * * *`;
  }
  return schedule.trim();
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function numericLiteral(node: ts.Expression | undefined): number | undefined {
  if (node === undefined) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}

function booleanLiteral(node: ts.Expression | undefined): boolean | undefined {
  if (node === undefined) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function memberDecorators(node: ts.MethodDeclaration): readonly ts.Decorator[] {
  const fromModifiers = (node.modifiers ?? []).filter((modifier) =>
    ts.isDecorator(modifier),
  ) as ts.Decorator[];
  const legacy = (node as ts.MethodDeclaration & { decorators?: readonly ts.Decorator[] })
    .decorators;
  return [...fromModifiers, ...(legacy ?? [])];
}

function decoratorName(expression: ts.Expression): string | undefined {
  let current = expression;
  while (ts.isCallExpression(current)) current = current.expression;
  if (ts.isIdentifier(current)) return current.text;
  if (!ts.isPropertyAccessExpression(current) || !ts.isIdentifier(current.name)) return undefined;
  return current.name.text;
}

function parseJobOptions(node: ts.Expression | undefined): {
  name?: string;
  allowConcurrent?: boolean;
  description?: string;
  timeoutMs?: number;
} {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return {};
  const opts: {
    name?: string;
    allowConcurrent?: boolean;
    description?: string;
    timeoutMs?: number;
  } = {};

  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const name = prop.name.text;
    const val = prop.initializer;
    if (name === 'name') opts.name = stringLiteral(val);
    else if (name === 'allowConcurrent') opts.allowConcurrent = booleanLiteral(val);
    else if (name === 'description') opts.description = stringLiteral(val);
    else if (name === 'timeoutMs') opts.timeoutMs = numericLiteral(val);
  }
  return opts;
}

function walkSourceFiles(dir: string, results: string[]): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ALWAYS_SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(fullPath, results);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(fullPath);
    }
  }
}

export function discoverScheduledJobsInFile(filePath: string): DiscoveredCronJob[] {
  let sourceText: string;
  try {
    sourceText = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  // Fast pre-filter
  if (!sourceText.includes('Cron')) return [];

  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const jobs: DiscoveredCronJob[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const methodName = member.name.text;
          const decorators = memberDecorators(member);
          for (const decorator of decorators) {
            if (!ts.isCallExpression(decorator.expression)) continue;
            const name = decoratorName(decorator.expression);
            if (name === 'Cron') {
              const [scheduleArg, optionsArg] = decorator.expression.arguments;
              const stringSchedule = stringLiteral(scheduleArg);
              const numSchedule = numericLiteral(scheduleArg);
              const schedule = stringSchedule ?? numSchedule;
              if (schedule === undefined) continue;

              const options = parseJobOptions(optionsArg);
              const jobId = options.name || `${className}.${methodName}`;
              const kebabId = options.name
                ? toKebabCase(options.name)
                : `${toKebabCase(className)}-${toKebabCase(methodName)}`;
              const cronExpression = normalizeCronExpression(schedule);

              jobs.push({
                jobId,
                kebabId,
                className,
                methodName,
                schedule,
                cronExpression,
                name: options.name,
                allowConcurrent: options.allowConcurrent ?? false,
                description: options.description,
                timeoutMs: options.timeoutMs,
                filePath,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return jobs;
}

export function discoverScheduledJobs(projectRoot: string): DiscoveredCronJob[] {
  const srcDir = join(projectRoot, 'src');
  const files: string[] = [];
  if (existsSync(srcDir)) {
    walkSourceFiles(srcDir, files);
  } else {
    walkSourceFiles(projectRoot, files);
  }

  const allJobs: DiscoveredCronJob[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    const jobs = discoverScheduledJobsInFile(file);
    for (const job of jobs) {
      if (!seenIds.has(job.jobId)) {
        seenIds.add(job.jobId);
        allJobs.push(job);
      }
    }
  }

  return allJobs;
}

/**
 * Renders the private invocation interface module.
 * Resolves the owning service through DI, awaits the method, and reports completion or failure.
 */
export function renderCronInvokerModule(jobs: readonly DiscoveredCronJob[]): string {
  return `// Private cron invocation interface generated by @di-framework/cli-plugin-platform
import { loadApplication } from 'virtual:di-framework-wasmcloud-runtime';

export const scheduledJobs = ${JSON.stringify(jobs, null, 2)};

/**
 * Invokes a scheduled method by resolving the owning service through DI,
 * awaiting execution, and returning a structured result.
 */
export async function invokeJob(jobId, context) {
  const application = await loadApplication();
  const container = application.default?.container ?? application.container ?? application.default;
  if (typeof container?.invokeCronJob !== 'function') {
    throw new TypeError('Scheduled application must export its registered container');
  }
  container.setCronMode('external');
  return await container.invokeCronJob(jobId, context);
}

export function listJobs() {
  return scheduledJobs;
}

export function getJob(jobId) {
  return scheduledJobs.find(
    (j) => j.jobId === jobId || j.name === jobId || \`\${j.className}.\${j.methodName}\` === jobId,
  );
}

export default {
  invokeJob,
  listJobs,
  getJob,
  scheduledJobs,
};
`;
}

/**
 * Adapter module used when a component has ONLY scheduled jobs and no HTTP ingress.
 */
export function renderCronAdapterModule(jobs: readonly DiscoveredCronJob[]): string {
  return `// Scheduled-only component adapter (no HTTP ingress)
export * from './cron-invoker.js';
import { invokeJob } from './cron-invoker.js';
import { getEnvironment } from 'wasi:cli/environment@0.3.0';

export const run = {
  async run() {
    const environment = Object.fromEntries(getEnvironment());
    const jobId = environment.DI_CRON_INVOKE_JOB;
    if (!jobId) throw new Error('DI_CRON_INVOKE_JOB is required');
    const result = await invokeJob(jobId);
    if (!result.success) throw new Error(result.error || 'Cron invocation failed');
  },
};
`;
}
