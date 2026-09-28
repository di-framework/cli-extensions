import type { ActorRpcRequest, ActorRuntime } from '@di-framework/actors';
import { authorizeControlRequest, unauthorizedResponse } from './control/auth';

export const ACTORS_INVOCATION_PATH = '/_actors/invoke';

export function isActorInvocationRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return url.pathname.startsWith('/_actors/');
  } catch {
    return false;
  }
}

function randomRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function handleActorInvocationRequest(
  request: Request,
  runtime?: ActorRuntime,
  dispatchFn?: (
    actorType: string,
    actorKey: string,
    method: string,
    args?: unknown[],
  ) => Promise<unknown>,
): Promise<Response> {
  if (!runtime && !dispatchFn) {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          name: 'ActorRuntimeError',
          message: 'No actor runtime or actors registered in this component',
        },
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  const auth = authorizeControlRequest(request, ['invoke']);
  if (!auth.ok) return unauthorizedResponse(auth);

  try {
    let actorType: string | undefined;
    let actorKey: string | undefined;
    let method: string | undefined;
    let args: unknown[] = [];
    let requestId = randomRequestId();
    let deadline: number | undefined;
    let namespace: string | undefined;
    const callerId = auth.identity.id;
    let expectedGeneration: number | undefined;

    const url = new URL(request.url);
    const subPath = url.pathname.replace(/^\/_actors\/?/, '');
    const pathParts = subPath ? subPath.split('/').filter(Boolean) : [];

    if (request.method === 'POST') {
      const parsed = await request.json().catch(() => ({}));
      const body =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      actorType = (body.actorType as string) ?? request.headers.get('x-actor-type') ?? pathParts[0];
      actorKey = (body.actorKey as string) ?? request.headers.get('x-actor-key') ?? pathParts[1];
      method = (body.method as string) ?? request.headers.get('x-actor-method') ?? pathParts[2];
      args = Array.isArray(body.args) ? body.args : [];
      if (typeof body.requestId === 'string' && body.requestId) requestId = body.requestId;
      if (typeof body.deadline === 'number') deadline = body.deadline;
      if (typeof body.namespace === 'string') namespace = body.namespace;
      if (typeof body.expectedGeneration === 'number') expectedGeneration = body.expectedGeneration;
    } else {
      actorType = request.headers.get('x-actor-type') ?? pathParts[0];
      actorKey = request.headers.get('x-actor-key') ?? pathParts[1];
      method = request.headers.get('x-actor-method') ?? pathParts[2];
      const qArgs = url.searchParams.get('args');
      if (qArgs) {
        try {
          const parsed = JSON.parse(qArgs);
          args = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          args = [qArgs];
        }
      }
      const headerDeadline = request.headers.get('x-actor-deadline');
      if (headerDeadline) deadline = Number(headerDeadline);
      namespace = request.headers.get('x-actor-namespace') ?? undefined;
    }

    if (
      typeof actorType !== 'string' ||
      !actorType ||
      typeof actorKey !== 'string' ||
      !actorKey ||
      typeof method !== 'string' ||
      !method
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            name: 'ActorInvocationBadRequest',
            message: 'actorType, actorKey, and method are required for actor invocation',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    if (runtime) {
      // Resolve via the portable package condition at componentize time so the
      // adapter never pulls bun:sqlite into the Wasm guest.
      const { ActorRpcDispatcher } = await import('@di-framework/actors/portable');
      // Always pass the options object: `instanceof ActorRuntime` fails across package
      // entrypoints (main vs portable) and would read `options.runtime` as undefined.
      const dispatcher = new ActorRpcDispatcher({ runtime });
      const rpcRequest: ActorRpcRequest = {
        requestId,
        namespace,
        actorType,
        actorKey,
        method,
        args,
        callerId,
        deadline,
        expectedGeneration,
      };
      const response = await dispatcher.dispatch(rpcRequest);
      const status = response.success
        ? 200
        : response.error?.name === 'ActorAuthorizationError'
          ? 403
          : response.error?.name === 'ActorDeadlineExceededError'
            ? 504
            : response.error?.name === 'ActorNotRegisteredError' ||
                response.error?.name === 'ActorMethodNotFoundError'
              ? 404
              : 500;
      return new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }

    const invoke = dispatchFn!;
    const result = await invoke(actorType, actorKey, method, args);
    return new Response(JSON.stringify({ requestId, success: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error: any) {
    const name =
      [
        'ActorNotRegisteredError',
        'ActorMethodNotFoundError',
        'ActorInvocationBadRequest',
        'ActorMigrationError',
        'ActorAuthorizationError',
        'ActorDeadlineExceededError',
      ].find((candidate) => candidate === error?.name) ?? 'ActorInvocationError';
    const isNotFound = name === 'ActorNotRegisteredError' || name === 'ActorMethodNotFoundError';
    const isBadRequest = name === 'ActorInvocationBadRequest';
    const isUnauthorized = name === 'ActorAuthorizationError';
    const isDeadline = name === 'ActorDeadlineExceededError';
    const status = isNotFound
      ? 404
      : isBadRequest
        ? 400
        : isUnauthorized
          ? 403
          : isDeadline
            ? 504
            : 500;
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          name,
          // Never echo handler exception text — it may contain private details.
          message: 'Actor invocation failed',
        },
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }
}
