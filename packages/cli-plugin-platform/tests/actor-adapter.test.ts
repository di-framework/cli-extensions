import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActorRuntime, SqliteActorStorage } from '@di-framework/actors';
import {
  ContractCounterActor,
  ContractFailingMigrationActor,
  defineActorContractSuite,
} from '@di-framework/actors/testing';
import {
  ACTORS_INVOCATION_PATH,
  createWasmcloudActorAdapter,
  type WasmcloudActorAdapter,
} from '../src/index';

describe('wasmCloud Actor Adapter Integration', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-contract-wasmcloud-'));
  let storage: SqliteActorStorage | undefined;
  let runtime: ActorRuntime | undefined;
  let adapter: WasmcloudActorAdapter | undefined;

  const initAdapter = () => {
    storage = new SqliteActorStorage({ baseDir: tempDir, fileLocking: true });
    runtime = new ActorRuntime({ storage });
    runtime.register(ContractCounterActor);
    runtime.register(ContractFailingMigrationActor);
    adapter = createWasmcloudActorAdapter(runtime);
  };

  initAdapter();

  defineActorContractSuite({
    name: 'WasmcloudActorAdapter',
    createAdapter: async () => {
      if (!adapter) initAdapter();
      return {
        async invoke(actorType: string, actorKey: string, method: string, args: unknown[] = []) {
          return await adapter!.invoke(actorType, actorKey, method, args);
        },
        async restart() {
          if (storage) await storage.close();
          initAdapter();
        },
        async simulateBindingFailure() {
          if (storage) await storage.close();
          const invalidFile = path.join(tempDir, 'invalid-dir-file');
          fs.writeFileSync(invalidFile, 'not-a-dir');
          storage = new SqliteActorStorage({
            baseDir: path.join(invalidFile, 'sub'),
            fileLocking: true,
          });
          runtime = new ActorRuntime({ storage });
          runtime.register(ContractCounterActor);
          adapter = createWasmcloudActorAdapter(runtime);
        },
      };
    },
  });

  describe('HTTP Protocol Invocations', () => {
    beforeEach(() => {
      initAdapter();
    });
    it('handles POST /_actors/invoke with body payload', async () => {
      const req = new Request(`http://localhost${ACTORS_INVOCATION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorType: 'ContractCounter',
          actorKey: 'http-1',
          method: 'increment',
          args: [10],
        }),
      });

      const res = await adapter!.handle(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.result).toBe(10);
      expect(typeof json.requestId).toBe('string');
    });

    it('returns 400 when required invocation parameters are missing', async () => {
      const req = new Request(`http://localhost${ACTORS_INVOCATION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorType: 'ContractCounter' }),
      });

      const res = await adapter!.handle(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.name).toBe('ActorInvocationBadRequest');
    });

    it('returns 404 for unknown actor or method', async () => {
      const req = new Request(`http://localhost${ACTORS_INVOCATION_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorType: 'UnknownActor',
          actorKey: 'k',
          method: 'm',
        }),
      });

      const res = await adapter!.handle(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.name).toBe('ActorNotRegisteredError');
    });
  });

  afterAll(async () => {
    if (storage) {
      await storage.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });
});

it('parses actor paths, headers and query arguments and limits error details', async () => {
  const { isActorInvocationRequest, handleActorInvocationRequest } = await import('../src/actors');
  expect(isActorInvocationRequest({ url: 'invalid' } as Request)).toBe(false);
  expect(isActorInvocationRequest(new Request('http://local/actors/invoke'))).toBe(false);
  expect(
    isActorInvocationRequest(
      new Request('http://local/', { headers: { 'x-actor-type': 'Counter' } }),
    ),
  ).toBe(false);
  expect(
    isActorInvocationRequest(
      new Request('http://local/', { headers: { 'x-actor-dispatch': 'true' } }),
    ),
  ).toBe(false);
  expect(isActorInvocationRequest(new Request('http://local/'))).toBe(false);
  expect((await handleActorInvocationRequest(new Request('http://local/'))).status).toBe(404);
  for (const [query, expected] of [
    ['[1,2]', [1, 2]],
    ['3', [3]],
    ['raw', ['raw']],
  ] as const) {
    const req = new Request(
      'http://local/_actors/Counter/key/read?args=' + encodeURIComponent(query),
    );
    const response = await handleActorInvocationRequest(
      req,
      undefined,
      async (type, key, method, args) => ({ type, key, method, args }),
    );
    expect(await response.json()).toMatchObject({
      success: true,
      result: { type: 'Counter', key: 'key', method: 'read', args: expected },
    });
  }
  const bad = new Request('http://local/_actors/invoke', { method: 'POST', body: '{bad' });
  expect((await handleActorInvocationRequest(bad, undefined, async () => 1)).status).toBe(400);
  for (const name of [
    'Error',
    'ActorInvocationBadRequest',
    'ActorMethodNotFoundError',
    'ActorMigrationError',
  ]) {
    const response = await handleActorInvocationRequest(
      new Request('http://local/_actors/Counter/key/read'),
      undefined,
      async () => {
        throw Object.assign(new Error('private detail'), {
          name,
          migration: { stack: 'private stack' },
        });
      },
    );
    const body = await response.text();
    expect(body).not.toContain('private');
    expect(response.status).toBe(
      name === 'ActorInvocationBadRequest' ? 400 : name === 'ActorMethodNotFoundError' ? 404 : 500,
    );
  }
  const runtime = new ActorRuntime();
  class Plain {
    read() {
      return 'ok';
    }
  }
  runtime.register(Plain);
  const adapter = createWasmcloudActorAdapter(runtime);
  expect(await adapter.dispatchActorInvocation('Plain', 'key', 'read')).toBe('ok');
  const response = await handleActorInvocationRequest(
    new Request('http://local/_actors/Plain/key/read'),
    runtime,
  );
  expect((await response.json()).result).toBe('ok');
  await runtime.clear();
});

it('treats non-object JSON and invalid identity fields as bad requests', async () => {
  const { handleActorInvocationRequest } = await import('../src/actor-protocol');
  let calls = 0;
  const dispatch = async () => {
    calls++;
    return 1;
  };
  for (const body of [
    null,
    true,
    7,
    'text',
    [],
    { actorType: 7, actorKey: 'key', method: 'read' },
  ]) {
    const response = await handleActorInvocationRequest(
      new Request('http://localhost/_actors/', { method: 'POST', body: JSON.stringify(body) }),
      undefined,
      dispatch,
    );
    expect(response.status).toBe(400);
  }
  expect(calls).toBe(0);
  const response = await handleActorInvocationRequest(
    new Request('http://localhost/_actors/Counter/key/read', { method: 'POST', body: 'null' }),
    undefined,
    dispatch,
  );
  expect(response.status).toBe(200);
  expect(calls).toBe(1);
});

it('binds callerId to the authenticated control identity', async () => {
  const TOKEN = 'viewer-token';
  process.env.DI_CONTROL_IDENTITIES = JSON.stringify([
    { id: 'viewer', token: TOKEN, roles: ['invoke'] },
  ]);
  const { handleActorInvocationRequest } = await import('../src/actor-protocol');
  const { ActorRpcDispatcher } = await import('@di-framework/actors/portable');
  const runtime = { invoke: async () => 1 } as unknown as ActorRuntime;
  const original = ActorRpcDispatcher.prototype.dispatch;
  const seen: unknown[] = [];
  try {
    ActorRpcDispatcher.prototype.dispatch = async function dispatch(request) {
      seen.push(request);
      return { requestId: request.requestId, success: true, result: 1 };
    };
    const body = await handleActorInvocationRequest(
      new Request('http://localhost/_actors/Counter/key/read', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          actorType: 'Counter',
          actorKey: 'k',
          method: 'read',
          callerId: 'trusted-gateway',
        }),
      }),
      runtime,
    );
    expect(body.status).toBe(200);
    expect(seen[0]).toMatchObject({ callerId: 'viewer' });
    const header = await handleActorInvocationRequest(
      new Request('http://localhost/_actors/Counter/key/read', {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-actor-caller': 'trusted-gateway',
        },
      }),
      runtime,
    );
    expect(header.status).toBe(200);
    expect(seen[1]).toMatchObject({ callerId: 'viewer' });
  } finally {
    ActorRpcDispatcher.prototype.dispatch = original;
    delete process.env.DI_CONTROL_IDENTITIES;
  }
});

it('maps ActorRpcDispatcher error names to HTTP status codes', async () => {
  const { handleActorInvocationRequest } = await import('../src/actor-protocol');
  const { ActorRpcDispatcher } = await import('@di-framework/actors/portable');
  const runtime = { invoke: async () => 1 };
  const request = new Request('http://localhost/_actors/Counter/key/read', {
    method: 'POST',
    body: JSON.stringify({ actorType: 'Counter', actorKey: 'k', method: 'read' }),
  });
  const original = ActorRpcDispatcher.prototype.dispatch;
  try {
    for (const [errorName, status] of [
      ['ActorAuthorizationError', 403],
      ['ActorDeadlineExceededError', 504],
      ['ActorNotRegisteredError', 404],
      ['ActorMethodNotFoundError', 404],
      ['ActorInvocationError', 500],
    ] as const) {
      ActorRpcDispatcher.prototype.dispatch = async () => ({
        requestId: 'req-test',
        success: false,
        error: { name: errorName, message: 'sanitized upstream' },
      });
      const response = await handleActorInvocationRequest(request, runtime as any);
      expect(response.status).toBe(status);
      expect((await response.json()).error?.name).toBe(errorName);
    }
  } finally {
    ActorRpcDispatcher.prototype.dispatch = original;
  }
});
