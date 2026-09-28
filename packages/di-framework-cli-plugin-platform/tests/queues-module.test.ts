import { describe, expect, it } from 'bun:test';
import { emptyQueuesModule, renderQueuesModule } from '../src/queues-module';

describe('renderQueuesModule', () => {
  it('serializes handler config and emits worker bootstrap helpers', () => {
    const handlers = [
      {
        className: 'ReceiptWorker',
        methodName: 'processReceipt',
        queueName: 'receipts',
        filePath: '/app/src/worker.ts',
        options: { concurrency: 3, maxRetries: 2, backoffMs: 50, timeoutMs: 1000 },
      },
      {
        className: 'AlertWorker',
        methodName: 'sendAlert',
        queueName: 'alerts',
        filePath: '/app/src/alerts.ts',
        options: {},
      },
    ];
    const source = renderQueuesModule(handlers);
    expect(source).toContain('"queueName": "receipts"');
    expect(source).toContain('"className": "ReceiptWorker"');
    expect(source).toContain('WasmSqliteQueueBackend');
    expect(source).toContain('ensureQueueWorkers');
    expect(source).toContain('pumpQueueWorkers');
    expect(source).toContain("handler.queueName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()");
    expect(source).toContain("'_CONCURRENCY'");
    expect(source).toContain('ContainerQueueDispatcher');
    expect(source).toContain('resolveQueueDbPath');
  });

  it('provides empty stubs when no queue handlers are discovered', () => {
    const source = emptyQueuesModule();
    expect(source).toContain('queueBackend = undefined');
    expect(source).toContain('async function ensureQueueWorkers() {}');
    expect(source).toContain('return 0');
  });
});
