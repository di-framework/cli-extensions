import {
  handleActorInvocationRequest,
  isActorInvocationRequest as isActorInvocation,
} from '../src/actor-protocol';
import {
  allowControlSurface,
  controlSurfaceNotFound,
  handleCronInvokeRequest,
  handleQueueControlRequest,
  isCronInvokeRequest,
  isQueueControlRequest,
} from '../src/control/index';
// Keep this side-effect import first: application services can resolve bindings at module startup.
import 'virtual:di-framework-wasmcloud-guests';
import 'virtual:di-framework-wasmcloud-actors';

import application from 'virtual:di-framework-application';
import { dispatchActorInvocation, getActorRuntime } from 'virtual:di-framework-wasmcloud-actors';
import { invokeJob as cronInvokeJob } from 'virtual:di-framework-wasmcloud-cron';
import { guests as wasmcloudGuests } from 'virtual:di-framework-wasmcloud-guests';
import {
  ensureQueueWorkers,
  getQueueBackend,
  pumpQueueWorkers,
} from 'virtual:di-framework-wasmcloud-queues';
import { ensureWasiEnvironment } from 'virtual:di-framework-wasmcloud-runtime';
import { Fields, Request as WasiRequest, Response as WasiResponse } from 'wasi:http/types@0.3.0';
import { collectBytes } from './fetch-runtime.ts';

export function requireGuestsObject(value: unknown): asserts value is object {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('wasmCloud guests module must export a guests object');
  }
}

requireGuestsObject(wasmcloudGuests);

type Application =
  | ((request: Request) => Response | Promise<Response>)
  | { fetch(request: Request): Response | Promise<Response> };

type WasiResult<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: unknown };
type WasiOk = { tag: 'ok'; val: undefined };

type QjsFutureFactory = ((type?: unknown) => {
  readable: unknown;
  writable: { write(value: unknown): unknown };
}) &
  Record<string, unknown>;

const TRAILER_FUTURE_TYPES = ['RESULT_OPTION_OTHER_ERROR_CODE'] as const;
const VOID_RESULT_FUTURE_TYPES = ['RESULT_VOID_ERROR_CODE'] as const;

function qjsFutureFactory(): QjsFutureFactory | undefined {
  const future = (globalThis as { wit?: { Future?: QjsFutureFactory } }).wit?.Future;
  return typeof future === 'function' ? future : undefined;
}

function pickFutureType(factory: QjsFutureFactory, preferred: readonly string[]): unknown {
  for (const name of preferred) {
    if (name in factory) return factory[name];
  }
  const fallback = Object.keys(factory).find((key) => key !== 'types' && key !== 'from');
  return fallback === undefined ? undefined : factory[fallback];
}

/** qjs panics if a JS Promise is passed where WIT expects a future handle. */
function lowerFuture(payload: unknown, preferredTypes: readonly string[]): unknown {
  const factory = qjsFutureFactory();
  if (factory === undefined) return Promise.resolve(payload);
  const pair = factory(pickFutureType(factory, preferredTypes));
  pair.writable.write(payload);
  return pair.readable;
}

function methodName(method: { tag: string; val?: string } | undefined): string {
  if (method === undefined) return 'GET';
  return method.tag === 'other' ? (method.val ?? 'GET') : method.tag.toUpperCase();
}

function firstOfTuple<T>(value: T | [T, ...unknown[]] | { res: T }): T {
  if (Array.isArray(value)) return value[0];
  if (value !== null && typeof value === 'object' && 'res' in value) return value.res;
  return value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return value != null && typeof value === 'object' && Symbol.asyncIterator in value;
}

async function* bytesAsStream(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.length > 0) yield bytes;
}

async function toWebRequest(incoming: {
  getMethod(): { tag: string; val?: string } | undefined;
  getScheme(): { tag: string } | undefined | null;
  getAuthority(): string | undefined | null;
  getPathWithQuery(): string | undefined | null;
  getHeaders(): { copyAll(): Array<[string, Uint8Array]> };
}): Promise<Request> {
  const method = methodName(incoming.getMethod());
  const schemeValue = incoming.getScheme();
  const scheme = schemeValue?.tag === 'HTTPS' ? 'https' : 'http';
  const authority = incoming.getAuthority() ?? 'localhost';
  const path = incoming.getPathWithQuery() ?? '/';
  const decoder = new TextDecoder();
  const headers = new Headers();
  for (const [name, value] of incoming.getHeaders().copyAll()) {
    headers.append(name, decoder.decode(value));
  }

  if (method === 'GET' || method === 'HEAD') {
    return new Request(`${scheme}://${authority}${path}`, { method, headers });
  }

  let bodyBytes: Uint8Array | undefined;
  try {
    const consumed = (
      WasiRequest as unknown as {
        consumeBody(request: unknown, res: unknown): unknown;
      }
    ).consumeBody(
      incoming,
      lowerFuture({ tag: 'ok', val: undefined } satisfies WasiOk, VOID_RESULT_FUTURE_TYPES),
    );
    const body = firstOfTuple(
      consumed as AsyncIterable<Uint8Array> | [AsyncIterable<Uint8Array>, ...unknown[]],
    );
    if (isAsyncIterable(body)) {
      const bytes = await collectBytes(body);
      if (bytes.length > 0) bodyBytes = bytes;
    }
  } catch {
    bodyBytes = undefined;
  }

  return new Request(`${scheme}://${authority}${path}`, {
    method,
    headers,
    body: bodyBytes as BodyInit | undefined,
  });
}

async function handleActorInvocation(request: Request): Promise<Response> {
  const runtime = typeof getActorRuntime === 'function' ? getActorRuntime() : undefined;
  return handleActorInvocationRequest(request, runtime as any, dispatchActorInvocation as any);
}

async function dispatch(request: Request): Promise<Response> {
  const handler = application as Application;
  const runtime = typeof getActorRuntime === 'function' ? getActorRuntime() : undefined;
  if (!handler || (typeof handler !== 'function' && typeof (handler as any).fetch !== 'function')) {
    if (runtime) {
      return new Response(
        JSON.stringify({
          name: 'wasmcloud-actor-component',
          actors: (runtime as any).getRegisteredActors?.()?.map((a: any) => a.name) ?? [],
          status: 'running',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new TypeError('The default application export must return a Web Response object');
  }

  const response =
    typeof handler === 'function' ? await handler(request) : await handler.fetch(request);

  if (!(response instanceof Response)) {
    throw new TypeError('The default application export must return a Web Response object');
  }

  return response;
}

async function responseContents(response: Response): Promise<AsyncIterable<Uint8Array> | null> {
  const body = response.body;
  if (isAsyncIterable(body)) return body;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length > 0 ? bytesAsStream(bytes) : null;
}

async function fromWebResponse(response: Response): Promise<unknown> {
  const encoder = new TextEncoder();
  const headerPairs: Array<[string, Uint8Array]> = [];
  response.headers.forEach((value, name) => {
    headerPairs.push([name, encoder.encode(value)]);
  });
  const fields = Fields.fromList(headerPairs);
  const created = (
    WasiResponse as unknown as {
      new: (
        headers: unknown,
        contents: AsyncIterable<Uint8Array> | null,
        trailers: unknown,
      ) => unknown;
    }
  ).new(
    fields,
    await responseContents(response),
    lowerFuture({ tag: 'ok', val: null } satisfies WasiResult<null>, TRAILER_FUTURE_TYPES),
  );
  const outgoing = firstOfTuple(created as { setStatusCode?(status: number): void });
  outgoing.setStatusCode?.(response.status);
  return outgoing;
}

export const handler = {
  async handle(incoming: Parameters<typeof toWebRequest>[0]): Promise<unknown> {
    try {
      ensureWasiEnvironment();
      const request = await toWebRequest(incoming);
      const isControlPath =
        isCronInvokeRequest(request) ||
        isQueueControlRequest(request) ||
        isActorInvocation(request);
      if (isControlPath && !allowControlSurface(request)) {
        return await fromWebResponse(controlSurfaceNotFound());
      }
      if (isCronInvokeRequest(request)) {
        return await fromWebResponse(await handleCronInvokeRequest(request, cronInvokeJob as any));
      }
      if (isQueueControlRequest(request)) {
        await ensureQueueWorkers();
        const controlResponse = await handleQueueControlRequest(request, getQueueBackend() as any);
        try {
          await pumpQueueWorkers();
        } catch (error) {
          console.error('Queue worker pump failed', error);
        }
        return await fromWebResponse(controlResponse);
      }
      if (isActorInvocation(request)) {
        return await fromWebResponse(await handleActorInvocation(request));
      }
      return await fromWebResponse(await dispatch(request));
    } catch (error) {
      console.error('Unhandled DI Framework request error', error);
      return await fromWebResponse(
        new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
  },
};
