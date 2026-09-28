import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverQueueHandlers,
  isQueueWorkerProject,
  parseQueueHandlersInFile,
} from '../src/queues';
import { makeWorkspace } from './helpers';

test('queue discovery handles nested namespaces, decorator forms, and ignored directories', () => {
  const { root } = makeWorkspace();
  const src = join(root, 'src');
  mkdirSync(join(src, 'nested'), { recursive: true });
  const entryPath = join(src, 'nested', 'worker.ts');
  writeFileSync(
    entryPath,
    `
  namespace Workers { export class Worker {
    @ns.QueueHandler(\`receipts\`, { maxRetries: dynamic, backoffMs: 10, 'ignored': 9, ...extra })
    run() {}
    @QueueHandler() empty() {}
    @QueueHandler(variable) dynamic() {}
    @Other('ignored') other() {}
    @QueueHandler('bare', variable) options() {}
    @QueueHandler undecorated() {}
  } }
  `,
  );
  writeFileSync(join(src, 'plain.js'), 'export const value = 1;');
  for (const name of ['node_modules', 'dist', '.di-framework', '.git']) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, 'ignored.ts'),
      "class Ignored { @QueueHandler('ignored') run() {} }",
    );
  }
  const project = { projectRoot: root, entryPath } as any;
  expect(
    discoverQueueHandlers(project)
      .map((h) => h.queueName)
      .sort(),
  ).toEqual(['bare', 'receipts']);
  expect(parseQueueHandlersInFile(join(root, 'missing.ts'))).toEqual([]);
  expect(
    discoverQueueHandlers({
      projectRoot: join(root, 'missing'),
      entryPath: join(root, 'missing.ts'),
    } as any),
  ).toEqual([]);
  expect(isQueueWorkerProject(project, discoverQueueHandlers(project))).toBe(true);
  writeFileSync(join(src, 'http.ts'), '@Controller() class Http {}');
  expect(isQueueWorkerProject(project, discoverQueueHandlers(project))).toBe(false);
});
