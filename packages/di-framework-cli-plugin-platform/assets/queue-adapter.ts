// Keep this side-effect import first: application services can resolve bindings at module startup.
import 'virtual:di-framework-wasmcloud-guests';

import application from 'virtual:di-framework-application';
import { guests as wasmcloudGuests } from 'virtual:di-framework-wasmcloud-guests';

export function requireGuestsObject(value: unknown): asserts value is object {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('wasmCloud guests module must export a guests object');
  }
}

requireGuestsObject(wasmcloudGuests);

export type DispatchJob = {
  id: string;
  queue: string;
  payload: string;
  attempt: number;
  createdAt: bigint | number;
};

export async function dispatchJob(
  job: DispatchJob,
  app: any = application,
): Promise<{ tag: 'ok'; val: undefined } | { tag: 'err'; val: string }> {
  try {
    let parsedPayload: unknown = job.payload;
    if (typeof job.payload === 'string') {
      try {
        parsedPayload = JSON.parse(job.payload);
      } catch {
        parsedPayload = job.payload;
      }
    }

    const jobObject = {
      id: job.id,
      queueName: job.queue,
      payload: parsedPayload,
      attempts: Number(job.attempt ?? 1),
      maxRetries: 3,
      enqueuedAt: Number(job.createdAt ?? Date.now()),
      availableAt: Number(job.createdAt ?? Date.now()),
      priority: 0,
      backoffMs: 1000,
      timeoutMs: 30000,
      status: 'processing' as const,
    };

    if (typeof app?.dispatch === 'function') {
      await app.dispatch(job.queue, jobObject);
    } else if (typeof app?.execute === 'function') {
      await app.execute(jobObject);
    } else if (typeof app === 'function') {
      await app(jobObject);
    } else {
      throw new Error('No dispatcher found on default application export');
    }

    return { tag: 'ok', val: undefined };
  } catch (error) {
    console.error('Unhandled DI Framework queue dispatch error', error);
    return { tag: 'err', val: 'Queue dispatch failed' };
  }
}

// Top-level WIT results use the exception convention, unlike nested tagged results.
export const dispatch = {
  async dispatch(job: DispatchJob): Promise<void> {
    const result = await dispatchJob(job);
    if (result.tag === 'err') throw result.val;
  },
};
