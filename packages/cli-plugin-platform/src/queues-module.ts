import type { DiscoveredQueueHandler } from './queues';

/** Generated module that opens SQLite-backed queues and pumps workers per request. */
export function renderQueuesModule(handlers: readonly DiscoveredQueueHandler[]): string {
  return `import { WasmSqliteQueueBackend, QueueWorker, ContainerQueueDispatcher } from '@di-framework/queues';
import { loadApplication } from 'virtual:di-framework-wasmcloud-runtime';

const handlerConfig = ${JSON.stringify(
    handlers.map((handler) => ({
      queueName: handler.queueName,
      className: handler.className,
      methodName: handler.methodName,
      options: handler.options,
    })),
    null,
    2,
  )};

let queueBackend;
let queueWorker;
let workerReady;
let workerInit;

function resolveQueueDbPath() {
  const storageDir = process.env.DI_STORAGE_DIR || '.';
  return process.env.QUEUE_DB_PATH || (storageDir.replace(/\\/$/, '') + '/queue.db');
}

export function getQueueBackend() {
  if (!queueBackend) {
    queueBackend = new WasmSqliteQueueBackend(resolveQueueDbPath());
  }
  return queueBackend;
}

async function ensureWorker() {
  if (workerReady) return workerReady;
  if (!workerInit) {
    workerInit = (async () => {
      const backend = getQueueBackend();
      const application = await loadApplication();
      const exported = application.default ?? application;
      const container = exported?.container ?? exported;
      // Prefer the nested ContainerQueueDispatcher (apps attach it as \`default\`).
      // Do NOT treat itty-router's \`dispatch\` as a queue dispatcher.
      const dispatcher =
        exported instanceof ContainerQueueDispatcher
          ? exported
          : exported?.default instanceof ContainerQueueDispatcher
            ? exported.default
            : new ContainerQueueDispatcher(container);
      const queues = handlerConfig.map((handler) => handler.queueName);
      const concurrency = Math.max(
        1,
        ...handlerConfig.map((handler) => {
          const envName =
            'DI_QUEUE_' +
            handler.queueName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() +
            '_CONCURRENCY';
          return Number(process.env[envName] ?? handler.options.concurrency ?? 1);
        }),
      );
      // Wasm HTTP tasks are request-scoped: do not start setTimeout poll loops.
      queueWorker = new QueueWorker(backend, dispatcher, { queues, concurrency });
      workerReady = queueWorker;
      return queueWorker;
    })().catch((error) => {
      workerInit = undefined;
      workerReady = undefined;
      throw error;
    });
  }
  return workerInit;
}

export async function ensureQueueWorkers() {
  await ensureWorker();
}

/** Drain pending jobs during this HTTP invocation (request-driven Wasm worker). */
export async function pumpQueueWorkers(maxJobsPerQueue = 32) {
  const worker = await ensureWorker();
  return worker.pump(maxJobsPerQueue);
}

export const queueHandlers = handlerConfig;
`;
}

export function emptyQueuesModule(): string {
  return `export const queueBackend = undefined;
export function getQueueBackend() { return undefined; }
export async function ensureQueueWorkers() {}
export async function pumpQueueWorkers() { return 0; }
`;
}
