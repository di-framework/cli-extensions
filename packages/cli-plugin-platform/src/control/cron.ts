import { authorizeControlRequest, unauthorizedResponse } from './auth';

export const CRON_INVOKE_PATH_PREFIX = '/_di/cron/';

export type CronInvoker = (jobId: string, context?: Record<string, unknown>) => Promise<unknown>;

export function isCronInvokeRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return request.method === 'POST' && url.pathname.startsWith(CRON_INVOKE_PATH_PREFIX);
  } catch {
    return false;
  }
}

export function cronJobIdFromRequest(request: Request): string | undefined {
  try {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(CRON_INVOKE_PATH_PREFIX)) return undefined;
    const rest = url.pathname.slice(CRON_INVOKE_PATH_PREFIX.length);
    const jobId = decodeURIComponent(rest.replace(/\/$/, '').split('/')[0] ?? '');
    return jobId || undefined;
  } catch {
    return undefined;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function cronFailureResponse(jobId: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      completed: false,
      ok: false,
      jobId,
      error: { name: 'CronInvocationError', message: 'Cron job failed' },
    }),
    { status: 500, headers: JSON_HEADERS },
  );
}

/** CronExecutionResult-shaped failures must not be reported as HTTP success. */
export function isFailedCronResult(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const record = result as {
    success?: unknown;
    ok?: unknown;
    completed?: unknown;
    status?: unknown;
  };
  if (record.success === false || record.ok === false || record.completed === false) return true;
  return record.status === 'failure' || record.status === 'skipped';
}

export async function handleCronInvokeRequest(
  request: Request,
  invoke: CronInvoker | undefined,
): Promise<Response> {
  const auth = authorizeControlRequest(request, ['invoke']);
  if (!auth.ok) return unauthorizedResponse(auth);

  const jobId = cronJobIdFromRequest(request);
  if (!jobId) {
    return new Response(JSON.stringify({ success: false, error: 'Missing cron job id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (typeof invoke !== 'function') {
    return new Response(JSON.stringify({ success: false, error: 'No cron invoker registered' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  try {
    const result = await invoke(jobId, { ...body, caller: auth.identity.id });
    if (isFailedCronResult(result)) return cronFailureResponse(jobId);
    return new Response(
      JSON.stringify({
        success: true,
        completed: true,
        ok: true,
        jobId,
        result,
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch {
    return cronFailureResponse(jobId);
  }
}
