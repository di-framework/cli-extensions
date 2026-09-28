import { afterEach, describe, expect, it, mock } from 'bun:test';
import { HeadersPolyfill } from '../assets/fetch-runtime';

type ApplicationHandler =
  | ((request: Request) => Response | Promise<Response>)
  | { fetch(request: Request): Response | Promise<Response> };

type Outgoing = {
  headers: unknown;
  contents: unknown;
  trailers: unknown;
  statusCode: number;
  setStatusCode(status: number): void;
};

const applicationState: { current: ApplicationHandler } = {
  current: () => new Response('ok'),
};

function defaultOutgoing(headers: unknown, contents: unknown, trailers: unknown): Outgoing {
  const outgoing: Outgoing = {
    headers,
    contents,
    trailers,
    statusCode: 0,
    setStatusCode(status: number) {
      outgoing.statusCode = status;
    },
  };
  return outgoing;
}

const wasiState = {
  consumeBody: (_request: unknown, _res: Promise<unknown>): unknown => {
    throw new Error('consumeBody was not stubbed');
  },
  newResponse: (headers: unknown, contents: unknown, trailers: unknown): unknown =>
    defaultOutgoing(headers, contents, trailers),
};

mock.module('virtual:di-framework-wasmcloud-guests', () => ({
  guests: {},
}));

mock.module('virtual:di-framework-wasmcloud-actors', () => ({
  actorRuntime: undefined,
  getActorRuntime: () => undefined,
  dispatchActorInvocation: undefined,
  actors: [],
}));

mock.module('virtual:di-framework-wasmcloud-cron', () => ({
  invokeJob: async () => ({ completed: true }),
}));

const queueState = {
  backend: undefined as
    | {
        listQueues(): Promise<Array<{ name: string }>>;
      }
    | undefined,
  ensureCalls: 0,
  pumpCalls: 0,
  pumpError: false,
};

mock.module('virtual:di-framework-wasmcloud-queues', () => ({
  getQueueBackend: () => queueState.backend,
  ensureQueueWorkers: async () => {
    queueState.ensureCalls += 1;
  },
  pumpQueueWorkers: async () => {
    queueState.pumpCalls += 1;
    if (queueState.pumpError) throw new Error('pump failed');
    return 2;
  },
}));

mock.module('virtual:di-framework-wasmcloud-runtime', () => ({
  ensureWasiEnvironment: () => undefined,
  loadApplication: async () => ({}),
}));

mock.module('virtual:di-framework-application', () => ({
  default: (request: Request) => {
    const current = applicationState.current;
    return typeof current === 'function' ? current(request) : current.fetch(request);
  },
}));

mock.module('wasi:http/types@0.3.0', () => ({
  Fields: {
    fromList(entries: Array<[string, Uint8Array]>) {
      return { entries };
    },
  },
  Request: {
    consumeBody(request: unknown, res: Promise<unknown>) {
      return wasiState.consumeBody(request, res);
    },
  },
  Response: {
    new(headers: unknown, contents: unknown, trailers: unknown) {
      return wasiState.newResponse(headers, contents, trailers);
    },
  },
}));

const httpAdapter = await import(`../assets/http-adapter.ts?t=${Date.now()}`);
const { handler, requireGuestsObject } = httpAdapter;

function readable(...values: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

function incoming(
  overrides: {
    method?: { tag: string; val?: string };
    scheme?: { tag: string } | null;
    authority?: string | null;
    path?: string | null;
    headers?: Array<[string, Uint8Array]>;
  } = {},
) {
  return {
    getMethod: () => overrides.method,
    getScheme: () => overrides.scheme,
    getAuthority: () => overrides.authority,
    getPathWithQuery: () => overrides.path,
    getHeaders: () => ({
      copyAll: () => overrides.headers ?? [['accept', new TextEncoder().encode('text/plain')]],
    }),
  };
}

afterEach(() => {
  delete process.env.DI_CONTROL_REJECT_FORWARDED;
  delete process.env.DI_CONTROL_HTTP_HOST;
  applicationState.current = () => new Response('ok');
  wasiState.consumeBody = () => {
    throw new Error('consumeBody was not stubbed');
  };
  wasiState.newResponse = (headers, contents, trailers) =>
    defaultOutgoing(headers, contents, trailers);
  delete (globalThis as { wit?: unknown }).wit;
  queueState.backend = undefined;
  queueState.ensureCalls = 0;
  queueState.pumpCalls = 0;
  queueState.pumpError = false;
});

describe('http adapter', () => {
  it('translates a GET request through the default function export', async () => {
    applicationState.current = () => new Response('hello', { status: 201 });
    const outgoing = (await handler.handle(
      incoming({
        method: { tag: 'get' },
        scheme: { tag: 'HTTPS' },
        authority: 'example.com',
        path: '/greet',
      }),
    )) as Outgoing;
    expect(outgoing.statusCode).toBe(201);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(new TextDecoder().decode(new Uint8Array(collected))).toBe('hello');
  });

  it('defaults missing method, scheme, authority, and path', async () => {
    const seen: string[] = [];
    applicationState.current = (request) => {
      seen.push(`${request.method} ${request.url}`);
      return new Response(null, { status: 204 });
    };
    const outgoing = (await handler.handle(
      incoming({ method: undefined, scheme: null, authority: null, path: null }),
    )) as Outgoing;
    expect(seen).toEqual(['GET http://localhost/']);
    expect(outgoing.statusCode).toBe(204);
    expect(outgoing.contents).toBeNull();
    await handler.handle(incoming({ method: { tag: 'other' }, path: '/other' }));
    expect(seen).toEqual(['GET http://localhost/', 'GET http://localhost/other']);
  });

  it('maps other methods and consumes a streaming POST body', async () => {
    const seen: string[] = [];
    applicationState.current = {
      async fetch(request) {
        seen.push(`${request.method}:${await request.text()}`);
        return new Response(readable(new Uint8Array([9, 8])));
      },
    };
    wasiState.consumeBody = () => readable(new TextEncoder().encode('payload'));
    const outgoing = (await handler.handle(
      incoming({
        method: { tag: 'other', val: 'PURGE' },
        scheme: { tag: 'HTTP' },
        authority: 'app.local',
        path: '/items',
      }),
    )) as Outgoing;
    expect(seen).toEqual(['PURGE:payload']);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(collected).toEqual([9, 8]);
  });

  it('buffers POST bodies so itty-router withContent can clone().json()', async () => {
    const seen: unknown[] = [];
    applicationState.current = async (request) => {
      const cloned = request.clone();
      seen.push(await cloned.json());
      return new Response('ok');
    };
    wasiState.consumeBody = () =>
      readable(new TextEncoder().encode('{"items":[{"sku":"mug","quantity":2}]}'));
    const outgoing = (await handler.handle(
      incoming({ method: { tag: 'post' }, path: '/quote' }),
    )) as Outgoing;
    expect(seen).toEqual([{ items: [{ sku: 'mug', quantity: 2 }] }]);
    expect(outgoing.statusCode).toBe(200);
  });

  it('unwraps consumeBody and Response.new tuples', async () => {
    applicationState.current = async (request) => new Response(await request.text());
    wasiState.consumeBody = () => [readable(new TextEncoder().encode('tuple'))];
    wasiState.newResponse = (headers, contents, trailers) => [
      {
        headers,
        contents,
        trailers,
        statusCode: 0,
        setStatusCode(status: number) {
          (this as Outgoing).statusCode = status;
        },
      } satisfies Outgoing,
    ];
    const outgoing = (await handler.handle(
      incoming({ method: { tag: 'post' }, path: '/tuple' }),
    )) as Outgoing;
    expect(outgoing.statusCode).toBe(200);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(new TextDecoder().decode(new Uint8Array(collected))).toBe('tuple');
  });

  it('unwraps result-shaped consumeBody and Response.new values', async () => {
    applicationState.current = () => new Response('res');
    wasiState.consumeBody = () => ({ res: { not: 'iterable' } });
    wasiState.newResponse = (headers, contents, trailers) => ({
      res: {
        headers,
        contents,
        trailers,
        statusCode: 0,
        setStatusCode(status: number) {
          this.statusCode = status;
        },
      } satisfies Outgoing,
    });
    const outgoing = (await handler.handle(
      incoming({ method: { tag: 'post' }, path: '/res' }),
    )) as Outgoing;
    expect(outgoing.statusCode).toBe(200);
  });

  it('ignores consumeBody failures and other-method fallbacks', async () => {
    applicationState.current = (request) => new Response(request.method);
    wasiState.consumeBody = () => {
      throw new Error('no body');
    };
    const outgoing = (await handler.handle(
      incoming({ method: { tag: 'put' }, path: '/headless' }),
    )) as Outgoing;
    expect(outgoing.statusCode).toBe(200);
  });

  it('buffers a Response whose body is not an async iterable', async () => {
    class BufferedResponse extends Response {
      constructor() {
        super('buffered');
      }
      override get body(): null {
        return null;
      }
    }
    applicationState.current = () => new BufferedResponse() as Response;
    const outgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(outgoing.statusCode).toBe(200);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(new TextDecoder().decode(new Uint8Array(collected))).toBe('buffered');
  });

  it('encodes headers from a polyfill that only implements forEach via entries', async () => {
    const headers = new HeadersPolyfill([
      ['content-type', 'text/plain'],
      ['x-from', 'polyfill'],
    ]);
    class PolyfillHeadersResponse extends Response {
      constructor() {
        super('polyfill-body', { status: 202 });
      }
      override get headers() {
        return headers as unknown as Headers;
      }
    }
    applicationState.current = () => new PolyfillHeadersResponse();
    const outgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(outgoing.statusCode).toBe(202);
    const encoded = outgoing.headers as { entries: Array<[string, Uint8Array]> };
    expect(encoded.entries.map(([name, value]) => [name, new TextDecoder().decode(value)])).toEqual(
      [
        ['content-type', 'text/plain'],
        ['x-from', 'polyfill'],
      ],
    );
  });

  it('returns a JSON 500 when the application export is not a Response', async () => {
    applicationState.current = () => 'not-a-response' as unknown as Response;
    const outgoing = (await handler.handle(incoming({ method: { tag: 'head' } }))) as Outgoing;
    expect(outgoing.statusCode).toBe(500);
    const collected: number[] = [];
    for await (const chunk of outgoing.contents as AsyncIterable<Uint8Array>) {
      collected.push(...chunk);
    }
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(collected)))).toEqual({
      error: 'Internal server error',
    });
  });

  it('lowers trailers and consume-body through wit.Future when qjs is present', async () => {
    const written: unknown[] = [];
    const trailersReadable = { kind: 'trailers' };
    const consumeReadable = { kind: 'consume' };
    const Future = Object.assign(
      (type: unknown) => {
        const readable = type === 'trailers-type' ? trailersReadable : consumeReadable;
        return {
          readable,
          writable: {
            write(value: unknown) {
              written.push({ type, value });
            },
          },
        };
      },
      {
        RESULT_OPTION_OTHER_ERROR_CODE: 'trailers-type',
        RESULT_VOID_ERROR_CODE: 'void-type',
      },
    );
    (globalThis as { wit?: unknown }).wit = { Future };

    const captured: unknown[] = [];
    wasiState.consumeBody = (_request, res) => {
      captured.push(res);
      return [readable(new TextEncoder().encode('payload'))];
    };

    const getOutgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(getOutgoing.trailers).toBe(trailersReadable);

    const postOutgoing = (await handler.handle(
      incoming({ method: { tag: 'post' }, path: '/body' }),
    )) as Outgoing;
    expect(captured).toEqual([consumeReadable]);
    expect(postOutgoing.statusCode).toBe(200);
    expect(written).toEqual([
      { type: 'trailers-type', value: { tag: 'ok', val: null } },
      { type: 'void-type', value: { tag: 'ok', val: undefined } },
      { type: 'trailers-type', value: { tag: 'ok', val: null } },
    ]);
  });

  it('routes cron and queue control requests through control handlers', async () => {
    queueState.backend = {
      async listQueues() {
        return [{ name: 'receipts' }];
      },
    };
    const cronOutgoing = (await handler.handle(
      incoming({ method: { tag: 'post' }, path: '/_di/cron/nightly/invoke' }),
    )) as Outgoing;
    expect(cronOutgoing.statusCode).toBe(200);

    const queueOutgoing = (await handler.handle(
      incoming({ method: { tag: 'get' }, path: '/_di/queues/' }),
    )) as Outgoing;
    expect(queueOutgoing.statusCode).toBe(200);
    expect(queueState.ensureCalls).toBe(1);
    expect(queueState.pumpCalls).toBe(1);

    queueState.pumpError = true;
    const errorLog: unknown[] = [];
    const originalError = console.error;
    console.error = (...args) => {
      errorLog.push(args);
    };
    try {
      const pumpFailure = (await handler.handle(
        incoming({ method: { tag: 'get' }, path: '/_di/queues/' }),
      )) as Outgoing;
      expect(pumpFailure.statusCode).toBe(200);
      expect(errorLog.join(' ')).toContain('Queue worker pump failed');
    } finally {
      console.error = originalError;
    }
  });

  it('hides control paths that arrive through forwarded ingress', async () => {
    process.env.DI_CONTROL_REJECT_FORWARDED = '1';
    process.env.DI_CONTROL_HTTP_HOST = 'greeter,greeter.wasmcloud.svc.cluster.local';
    const encoder = new TextEncoder();
    const forwarded = (await handler.handle(
      incoming({
        method: { tag: 'post' },
        authority: 'greeter',
        path: '/_di/cron/nightly/invoke',
        headers: [['x-forwarded-for', encoder.encode('203.0.113.1')]],
      }),
    )) as Outgoing;
    expect(forwarded.statusCode).toBe(404);

    const cluster = (await handler.handle(
      incoming({
        method: { tag: 'post' },
        authority: 'greeter',
        path: '/_di/cron/nightly/invoke',
        headers: [['host', encoder.encode('greeter')]],
      }),
    )) as Outgoing;
    expect(cluster.statusCode).toBe(200);
  });

  it('rejects a missing guests object', () => {
    expect(() => requireGuestsObject(null)).toThrow(TypeError);
    expect(() => requireGuestsObject('guests')).toThrow(
      'wasmCloud guests module must export a guests object',
    );
    expect(() => requireGuestsObject({})).not.toThrow();
  });

  it('picks a non-preferred wit.Future type and falls back when none remain', async () => {
    const written: unknown[] = [];
    const fallbackReadable = { kind: 'fallback' };
    const FutureWithFallback = Object.assign(
      (type: unknown) => ({
        readable: type === 'custom-type' ? fallbackReadable : { kind: 'other', type },
        writable: {
          write(value: unknown) {
            written.push({ type, value });
          },
        },
      }),
      { types: true, from: true, CUSTOM: 'custom-type' },
    );
    (globalThis as { wit?: unknown }).wit = { Future: FutureWithFallback };

    const outgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(outgoing.trailers).toBe(fallbackReadable);
    expect(written).toEqual([{ type: 'custom-type', value: { tag: 'ok', val: null } }]);

    const FutureEmpty = Object.assign(
      (type: unknown) => ({
        readable: { kind: 'empty', type },
        writable: {
          write(value: unknown) {
            written.push({ type, value });
          },
        },
      }),
      { types: true, from: true },
    );
    (globalThis as { wit?: unknown }).wit = { Future: FutureEmpty };
    const emptyOutgoing = (await handler.handle(incoming({ method: { tag: 'get' } }))) as Outgoing;
    expect(emptyOutgoing.trailers).toEqual({ kind: 'empty', type: undefined });
  });
});

describe('queue adapter', () => {
  it('converts WIT jobs to runtime jobs for every supported application entrypoint', async () => {
    const {
      dispatchJob,
      dispatch,
      requireGuestsObject: validateGuests,
    } = await import('../assets/queue-adapter.ts');
    const received: any[] = [];
    const accept = async (job: any) => {
      received.push(job);
    };
    const job = {
      id: 'job-1',
      queue: 'receipts',
      payload: '{"amount":7}',
      attempt: 2,
      createdAt: 123n,
    };
    for (const app of [
      {
        dispatch: async (queueName: string, job: any) => {
          expect(queueName).toBe('receipts');
          await accept(job);
        },
      },
      { execute: accept },
      accept,
    ]) {
      expect(await dispatchJob(job, app)).toEqual({ tag: 'ok', val: undefined });
    }
    expect(received).toHaveLength(3);
    expect(received[0]).toMatchObject({
      queueName: 'receipts',
      attempts: 2,
      enqueuedAt: 123,
      payload: { amount: 7 },
      status: 'processing',
    });
    await dispatchJob({ ...job, payload: 'plain' }, accept);
    expect(received[3].payload).toBe('plain');
    expect(await dispatch.dispatch(job)).toBeUndefined();
    expect(() => validateGuests(null)).toThrow('guests object');
    expect(() => validateGuests({})).not.toThrow();
  });

  it('returns a stable failure without leaking handler exception details', async () => {
    const { dispatchJob, dispatch } = await import('../assets/queue-adapter.ts');
    const job = { id: 'bad', queue: 'q', payload: '{}', attempt: 1, createdAt: 0 };
    expect(await dispatchJob(job, {})).toEqual({ tag: 'err', val: 'Queue dispatch failed' });
    applicationState.current = () => {
      throw new Error('private database details');
    };
    await expect(dispatch.dispatch(job)).rejects.toBe('Queue dispatch failed');
    expect(
      await dispatchJob(job, () => {
        throw new Error('private database details');
      }),
    ).toEqual({ tag: 'err', val: 'Queue dispatch failed' });
  });
});

it('routes only reserved actor paths and supports actor-only health responses', async () => {
  const noRuntime = (await handler.handle(
    incoming({ path: '/_actors/Counter/key/read' }),
  )) as Outgoing;
  expect(noRuntime.statusCode).toBe(404);
  const normal = (await handler.handle(
    incoming({ path: '/', headers: [['x-actor-type', new TextEncoder().encode('Counter')]] }),
  )) as Outgoing;
  expect(normal.statusCode).toBe(200);
  const runtime = {
    invoke: async (type: string, key: string, method: string) => ({ type, key, method }),
    getRegisteredActors: () => [{ name: 'Counter' }],
  };
  try {
    mock.module('virtual:di-framework-wasmcloud-actors', () => ({
      // Leave actorRuntime unset so the adapter uses dispatchActorInvocation
      // (ActorRpcDispatcher needs a full runtime surface).
      actorRuntime: undefined,
      getActorRuntime: () => undefined,
      dispatchActorInvocation: async (type: string, key: string, method: string) =>
        runtime.invoke(type, key, method),
      actors: [],
    }));
    const invoked = (await handler.handle(
      incoming({ path: '/_actors/Counter/key/read' }),
    )) as Outgoing;
    expect(invoked.statusCode).toBe(200);
    mock.module('virtual:di-framework-application', () => ({ default: undefined }));
    mock.module('virtual:di-framework-wasmcloud-actors', () => ({
      actorRuntime: runtime,
      getActorRuntime: () => runtime,
      dispatchActorInvocation: undefined,
      actors: [],
    }));
    const health = (await handler.handle(incoming({ path: '/' }))) as Outgoing;
    expect(health.statusCode).toBe(200);
    mock.module('virtual:di-framework-wasmcloud-actors', () => ({
      actorRuntime: undefined,
      getActorRuntime: () => undefined,
      dispatchActorInvocation: undefined,
      actors: [],
    }));
    const missingApplication = (await handler.handle(incoming({ path: '/' }))) as Outgoing;
    expect(missingApplication.statusCode).toBe(500);
  } finally {
    mock.module('virtual:di-framework-wasmcloud-actors', () => ({
      actorRuntime: undefined,
      getActorRuntime: () => undefined,
      dispatchActorInvocation: undefined,
      actors: [],
    }));
    mock.module('virtual:di-framework-application', () => ({
      default: (request: Request) => {
        const current = applicationState.current;
        return typeof current === 'function' ? current(request) : current.fetch(request);
      },
    }));
  }
});
