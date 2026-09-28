import { authorizeControlRequest, unauthorizedResponse } from './auth';

/** Structural queue backend surface used by the authenticated control HTTP API. */
export interface QueueControlBackend {
  enqueue(queueName: string, payload: unknown, options?: Record<string, unknown>): Promise<unknown>;
  listQueues(): Promise<Array<{ name: string }>>;
  listJobs(queueName: string, filter?: Record<string, unknown>): Promise<unknown[]>;
  getJob(queueName: string, jobId: string): Promise<{ queueName: string } | null>;
  retryJob(queueName: string, jobId?: string): Promise<unknown[]>;
}

export const QUEUE_CONTROL_PATH_PREFIX = '/_di/queues/';

export function isQueueControlRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return url.pathname.startsWith(QUEUE_CONTROL_PATH_PREFIX);
  } catch {
    return false;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleQueueControlRequest(
  request: Request,
  backend: QueueControlBackend | undefined,
): Promise<Response> {
  const auth = authorizeControlRequest(request, ['invoke']);
  if (!auth.ok) return unauthorizedResponse(auth);
  if (!backend) return json(404, { success: false, error: 'No queue backend registered' });

  const url = new URL(request.url);
  const parts = url.pathname.slice(QUEUE_CONTROL_PATH_PREFIX.length).split('/').filter(Boolean);
  const [queueName, action, jobId] = parts;

  if (!queueName) {
    if (request.method === 'GET') {
      const queues = await backend.listQueues();
      return json(200, { success: true, queues });
    }
    return json(400, { success: false, error: 'Queue name required' });
  }

  if (request.method === 'POST' && (action === undefined || action === 'jobs') && !jobId) {
    const body = (await request.json().catch(() => ({}))) as {
      payload?: unknown;
      idempotencyKey?: string;
      priority?: number;
      delayMs?: number;
      maxRetries?: number;
      backoffMs?: number;
      timeoutMs?: number;
    };
    if (body.payload === undefined) {
      return json(400, { success: false, error: 'payload is required' });
    }
    const job = await backend.enqueue(queueName, body.payload, {
      idempotencyKey: body.idempotencyKey,
      priority: body.priority,
      delayMs: body.delayMs,
      maxRetries: body.maxRetries,
      backoffMs: body.backoffMs,
      timeoutMs: body.timeoutMs,
    });
    return json(200, { success: true, job });
  }

  if (request.method === 'GET' && action === undefined) {
    const status = url.searchParams.get('status') ?? undefined;
    const jobs = await backend.listJobs(queueName, {
      status: status as any,
      limit: Number(url.searchParams.get('limit') ?? 50),
    });
    return json(200, { success: true, jobs });
  }

  if (request.method === 'GET' && (action === 'jobs' || action === 'inspect') && jobId) {
    const job = await backend.getJob(queueName, jobId);
    if (!job || job.queueName !== queueName) {
      return json(404, { success: false, error: 'Job not found' });
    }
    return json(200, { success: true, job });
  }

  if (request.method === 'POST' && action === 'retry') {
    const admin = authorizeControlRequest(request, ['admin']);
    if (!admin.ok) return unauthorizedResponse(admin);
    const jobs = await backend.retryJob(queueName, jobId);
    return json(200, { success: true, jobs });
  }

  if (request.method === 'GET' && action === 'info') {
    const queues = await backend.listQueues();
    const info = queues.find((entry: { name: string }) => entry.name === queueName) ?? null;
    return json(200, { success: true, info });
  }

  return json(404, { success: false, error: 'Unknown queue control route' });
}
