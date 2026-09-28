import { afterEach, describe, expect, it } from 'bun:test';
import { authorizeControlRequest, unauthorizedResponse } from '../src/control/auth';
import {
  cronJobIdFromRequest,
  handleCronInvokeRequest,
  isCronInvokeRequest,
  isFailedCronResult,
} from '../src/control/cron';
import { allowControlSurface } from '../src/control/network';
import {
  handleQueueControlRequest,
  isQueueControlRequest,
  type QueueControlBackend,
} from '../src/control/queues';

const TOKEN = 'secret-token';
const ADMIN_TOKEN = 'admin-token';

afterEach(() => {
  delete process.env.DI_CONTROL_IDENTITIES;
  delete process.env.DI_CONTROL_TOKEN;
  delete process.env.token;
  delete process.env.DI_CONTROL_IDENTITY;
  delete process.env.DI_CONTROL_REJECT_FORWARDED;
  delete process.env.DI_CONTROL_HTTP_HOST;
});

describe('control auth', () => {
  it('allows anonymous invoke without admin when no credentials are configured', () => {
    const result = authorizeControlRequest(new Request('http://local/'));
    expect(result).toEqual({
      ok: true,
      identity: { id: 'anonymous', token: '', roles: ['invoke'] },
    });
    expect(authorizeControlRequest(new Request('http://local/'), ['admin'])).toMatchObject({
      ok: false,
      status: 403,
      error: 'Insufficient control privileges',
    });
  });

  it('parses DI_CONTROL_IDENTITIES and enforces bearer, x-di-control-token, and roles', async () => {
    process.env.DI_CONTROL_IDENTITIES = JSON.stringify([
      { id: 'viewer', token: TOKEN, roles: ['invoke'] },
      { id: 'admin', token: ADMIN_TOKEN, roles: ['admin'] },
      { id: 'broken' },
      null,
    ]);
    expect(authorizeControlRequest(new Request('http://local/')).ok).toBe(false);
    const bearer = authorizeControlRequest(
      new Request('http://local/', { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(bearer).toMatchObject({ ok: true, identity: { id: 'viewer' } });
    const header = authorizeControlRequest(
      new Request('http://local/', { headers: { 'x-di-control-token': TOKEN } }),
    );
    expect(header.ok).toBe(true);
    expect(
      authorizeControlRequest(
        new Request('http://local/', { headers: { authorization: 'Bearer nope' } }),
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      authorizeControlRequest(
        new Request('http://local/', { headers: { authorization: `Bearer ${TOKEN}` } }),
        ['admin'],
      ),
    ).toMatchObject({ ok: false, status: 403, error: 'Insufficient control privileges' });
    const admin = authorizeControlRequest(
      new Request('http://local/', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      ['admin'],
    );
    expect(admin.ok).toBe(true);
    const denied = authorizeControlRequest(new Request('http://local/'), ['invoke']);
    expect(denied).toMatchObject({ ok: false, status: 401 });
    const body = unauthorizedResponse(denied as Extract<typeof denied, { ok: false }>);
    expect(body.status).toBe(401);
    expect(await body.json()).toEqual({ success: false, error: 'Missing control credentials' });
  });

  it('falls back to DI_CONTROL_TOKEN and ignores unrelated token env vars', () => {
    process.env.DI_CONTROL_IDENTITIES = '{not json';
    process.env.DI_CONTROL_TOKEN = TOKEN;
    process.env.DI_CONTROL_IDENTITY = 'ops';
    const result = authorizeControlRequest(
      new Request('http://local/', { headers: { authorization: `Bearer ${TOKEN}` } }),
      ['admin'],
    );
    expect(result).toMatchObject({ ok: true, identity: { id: 'ops', roles: ['invoke', 'admin'] } });
    delete process.env.DI_CONTROL_TOKEN;
    process.env.token = TOKEN;
    expect(
      authorizeControlRequest(new Request('http://local/', { headers: { authorization: TOKEN } })),
    ).toMatchObject({ ok: false, status: 401, error: 'Missing control credentials' });
  });

  it('fails closed when identities are configured but empty', () => {
    process.env.DI_CONTROL_IDENTITIES = '[]';
    expect(authorizeControlRequest(new Request('http://local/'))).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});

describe('control surface network gate', () => {
  it('allows local/dev when no cluster restriction is configured', () => {
    expect(allowControlSurface(new Request('http://local/_di/queues/'))).toBe(true);
    expect(
      allowControlSurface(
        new Request('http://local/_di/queues/', { headers: { 'x-forwarded-for': '1.2.3.4' } }),
      ),
    ).toBe(true);
  });

  it('rejects forwarded control requests when deployed', () => {
    process.env.DI_CONTROL_REJECT_FORWARDED = '1';
    expect(allowControlSurface(new Request('http://greeter/_di/cron/job/invoke'))).toBe(true);
    expect(
      allowControlSurface(
        new Request('http://greeter/_di/cron/job/invoke', {
          headers: { 'x-forwarded-for': '10.0.0.1' },
        }),
      ),
    ).toBe(false);
    expect(
      allowControlSurface(
        new Request('http://greeter/_actors/invoke', {
          headers: { 'x-forwarded-host': 'greeter.example.com' },
        }),
      ),
    ).toBe(false);
  });

  it('requires the cluster control host when DI_CONTROL_HTTP_HOST is set', () => {
    process.env.DI_CONTROL_HTTP_HOST = 'greeter,greeter.wasmcloud.svc.cluster.local';
    expect(
      allowControlSurface(
        new Request('http://greeter/_di/queues/', { headers: { host: 'greeter' } }),
      ),
    ).toBe(true);
    expect(
      allowControlSurface(
        new Request('http://other/_di/queues/', { headers: { host: 'other.example.com' } }),
      ),
    ).toBe(false);
    process.env.DI_CONTROL_REJECT_FORWARDED = '1';
    expect(
      allowControlSurface(
        new Request('http://greeter/_di/queues/', {
          headers: { host: 'greeter', 'x-forwarded-proto': 'https' },
        }),
      ),
    ).toBe(false);
  });
});

describe('cron control HTTP', () => {
  it('detects cron invoke requests and extracts job ids', () => {
    expect(isCronInvokeRequest({ url: 'bad' } as Request)).toBe(false);
    expect(
      isCronInvokeRequest(new Request('http://local/_di/cron/job/invoke', { method: 'GET' })),
    ).toBe(false);
    expect(
      isCronInvokeRequest(new Request('http://local/_di/cron/job/invoke', { method: 'POST' })),
    ).toBe(true);
    expect(cronJobIdFromRequest(new Request('http://local/other'))).toBeUndefined();
    expect(cronJobIdFromRequest(new Request('http://local/_di/cron/nightly%2Djob/invoke'))).toBe(
      'nightly-job',
    );
    expect(cronJobIdFromRequest({ url: 'invalid' } as Request)).toBeUndefined();
  });

  it('invokes jobs and maps success and failure responses', async () => {
    const ok = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/nightly/invoke', {
        method: 'POST',
        body: JSON.stringify({ source: 'test' }),
      }),
      async (jobId, context) => {
        expect(jobId).toBe('nightly');
        expect(context).toMatchObject({ source: 'test', caller: 'anonymous' });
        return { completed: true };
      },
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ success: true, completed: true, jobId: 'nightly' });

    const missing = await handleCronInvokeRequest(
      new Request('http://local/_di/cron//invoke', { method: 'POST' }),
      async () => 1,
    );
    expect(missing.status).toBe(400);

    const noInvoker = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/nightly/invoke', { method: 'POST' }),
      undefined,
    );
    expect(noInvoker.status).toBe(404);

    const failed = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/nightly/invoke', { method: 'POST', body: 'not-json' }),
      async () => {
        throw new Error('cron exploded');
      },
    );
    expect(failed.status).toBe(500);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({
      success: false,
      completed: false,
      ok: false,
      jobId: 'nightly',
      error: { name: 'CronInvocationError', message: 'Cron job failed' },
    });
    expect(JSON.stringify(failedBody)).not.toContain('cron exploded');

    const thrownString = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/nightly/invoke', { method: 'POST', body: '{}' }),
      async () => {
        throw 'secret stack';
      },
    );
    expect(thrownString.status).toBe(500);
    expect(JSON.stringify(await thrownString.json())).not.toContain('secret stack');

    const failedShape = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/nightly/invoke', { method: 'POST', body: '{}' }),
      async () => ({
        success: false,
        status: 'failure',
        error: 'internal schema detail',
      }),
    );
    expect(failedShape.status).toBe(500);
    const failedShapeBody = await failedShape.json();
    expect(failedShapeBody.ok).toBe(false);
    expect(JSON.stringify(failedShapeBody)).not.toContain('internal schema detail');

    const skipped = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/nightly/invoke', { method: 'POST', body: '{}' }),
      async () => ({ status: 'skipped', success: false }),
    );
    expect(skipped.status).toBe(500);

    const okFlag = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/sync/invoke', { method: 'POST', body: '{}' }),
      async () => ({ ok: true }),
    );
    expect((await okFlag.json()).completed).toBe(true);

    const successStatus = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/sync/invoke', { method: 'POST', body: '{}' }),
      async () => ({ status: 'success', success: true }),
    );
    expect(successStatus.status).toBe(200);

    const bareValue = await handleCronInvokeRequest(
      new Request('http://local/_di/cron/sync/invoke', { method: 'POST', body: '{}' }),
      async () => 1,
    );
    expect(bareValue.status).toBe(200);
    expect(isFailedCronResult(null)).toBe(false);
    expect(isFailedCronResult('ok')).toBe(false);
    expect(isFailedCronResult({ ok: false })).toBe(true);
    expect(isFailedCronResult({ completed: false })).toBe(true);
    expect(isFailedCronResult({ status: 'failure' })).toBe(true);
    expect(isFailedCronResult({ status: 'skipped' })).toBe(true);
  });
});

describe('queue control HTTP', () => {
  const backend: QueueControlBackend = {
    async enqueue(queueName, payload, options) {
      return { queueName, payload, options };
    },
    async listQueues() {
      return [{ name: 'receipts' }, { name: 'alerts' }];
    },
    async listJobs(queueName, filter) {
      return [{ queueName, filter }];
    },
    async getJob(queueName, jobId) {
      return jobId === 'job-1' && queueName === 'receipts' ? { queueName: 'receipts' } : null;
    },
    async retryJob(queueName, jobId) {
      return [{ queueName, jobId }];
    },
  };

  it('detects queue control paths', () => {
    expect(isQueueControlRequest({ url: 'bad' } as Request)).toBe(false);
    expect(isQueueControlRequest(new Request('http://local/_di/queues/receipts'))).toBe(true);
  });

  it('lists queues, enqueues jobs, inspects, retries, and rejects unknown routes', async () => {
    const listed = await handleQueueControlRequest(
      new Request('http://local/_di/queues/'),
      backend,
    );
    expect(await listed.json()).toEqual({
      success: true,
      queues: [{ name: 'receipts' }, { name: 'alerts' }],
    });

    const missingBackend = await handleQueueControlRequest(
      new Request('http://local/_di/queues/'),
      undefined,
    );
    expect(missingBackend.status).toBe(404);

    const needsName = await handleQueueControlRequest(
      new Request('http://local/_di/queues/', { method: 'POST' }),
      backend,
    );
    expect(needsName.status).toBe(400);

    const needsPayload = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts', { method: 'POST', body: '{}' }),
      backend,
    );
    expect(needsPayload.status).toBe(400);

    const enqueued = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts/jobs', {
        method: 'POST',
        body: JSON.stringify({ payload: { id: 1 }, priority: 2 }),
      }),
      backend,
    );
    expect(await enqueued.json()).toMatchObject({ success: true, job: { queueName: 'receipts' } });

    const jobs = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts?status=pending&limit=10'),
      backend,
    );
    expect(await jobs.json()).toMatchObject({ success: true, jobs: [{ queueName: 'receipts' }] });

    const inspect = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts/jobs/job-1'),
      backend,
    );
    expect(inspect.status).toBe(200);

    const missingJob = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts/jobs/missing'),
      backend,
    );
    expect(missingJob.status).toBe(404);

    const otherQueue = await handleQueueControlRequest(
      new Request('http://local/_di/queues/alerts/jobs/job-1'),
      backend,
    );
    expect(otherQueue.status).toBe(404);

    const info = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts/info'),
      backend,
    );
    expect(await info.json()).toMatchObject({ success: true, info: { name: 'receipts' } });

    const unknown = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts/unknown'),
      backend,
    );
    expect(unknown.status).toBe(404);
  });

  it('denies anonymous retry even when invoke is open', async () => {
    const denied = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts/retry/job-1', { method: 'POST' }),
      backend,
    );
    expect(denied.status).toBe(403);
  });

  it('requires admin role for retry operations when credentials are configured', async () => {
    process.env.DI_CONTROL_IDENTITIES = JSON.stringify([
      { id: 'viewer', token: TOKEN, roles: ['invoke'] },
      { id: 'admin', token: ADMIN_TOKEN, roles: ['admin'] },
    ]);
    const denied = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts/retry/job-1', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      backend,
    );
    expect(denied.status).toBe(403);
    const retried = await handleQueueControlRequest(
      new Request('http://local/_di/queues/receipts/retry/job-1', {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      backend,
    );
    expect(await retried.json()).toMatchObject({
      success: true,
      jobs: [{ queueName: 'receipts' }],
    });
  });
});
