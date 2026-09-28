/**
 * Ambient declarations for module specifiers that only exist inside a bundled
 * WebAssembly component: the virtual application entry injected by the build's
 * rolldown plugin, and the WASI HTTP interface provided by the component host.
 * Neither module resolves in this repository, so the adapter type-checks
 * against these stubs; they are not shipped in the tarball.
 */
declare module 'virtual:di-framework-application' {
  const application: unknown;
  export default application;
}

declare module 'virtual:di-framework-wasmcloud-actors' {
  export const actorRuntime: unknown;
  export function getActorRuntime(): unknown;
  export const dispatchActorInvocation: (
    actorType: string,
    actorKey: string,
    method: string,
    args?: unknown[],
  ) => Promise<unknown>;
  export const actors: unknown[];
}

declare module 'virtual:di-framework-wasmcloud-guests' {
  export const guests: Record<string, unknown>;
}

declare module 'wasi:http/types@0.3.0' {
  export const Fields: {
    fromList(entries: Array<[string, Uint8Array]>): unknown;
  };
  export const Request: {
    consumeBody(request: unknown, res: Promise<unknown>): unknown;
  };
  export const Response: {
    new(headers: unknown, contents: unknown, trailers: Promise<unknown>): unknown;
  };
}

declare module 'wasi:sockets/types@0.3.0' {
  export const TcpSocket: {
    create(family: 'ipv4' | 'ipv6'): unknown;
  };
  export const UdpSocket: {
    create(family: 'ipv4' | 'ipv6'): unknown;
  };
}

declare module 'wasi:sockets/ip-name-lookup@0.3.0' {
  export function resolveAddresses(name: string): Promise<unknown>;
}

declare module 'wasi:tls/client@0.3.0-draft' {
  export class Connector {
    constructor();
    send(cleartext: AsyncIterable<Uint8Array>): unknown;
    receive(ciphertext: AsyncIterable<Uint8Array>): unknown;
    static connect(connector: Connector, serverName: string): Promise<unknown>;
  }
}

declare module 'wasi:random/random@0.3.0' {
  export function getRandomBytes(maxLen: bigint | number): unknown;
}

declare module 'wasi:clocks/monotonic-clock@0.3.0' {
  export function now(): bigint | number;
  export function waitUntil(when: bigint | number): Promise<void>;
}

declare module '@babel/plugin-transform-async-to-generator' {
  const plugin: import('@babel/core').PluginItem;
  export default plugin;
}

declare module 'virtual:di-framework-wasmcloud-runtime' {
  export function ensureWasiEnvironment(): void;
  export function loadApplication(): Promise<any>;
}

declare module 'virtual:di-framework-wasmcloud-cron' {
  export function invokeJob(jobId: string, context?: Record<string, unknown>): Promise<unknown>;
}

declare module 'virtual:di-framework-wasmcloud-queues' {
  export function getQueueBackend(): unknown;
  export function ensureQueueWorkers(): Promise<void>;
  export function pumpQueueWorkers(maxJobsPerQueue?: number): Promise<number>;
}

declare module 'di-framework:sqlite/database@0.1.0' {
  export type SqlValue =
    | { tag: 'null' }
    | { tag: 'integer'; val: bigint | number }
    | { tag: 'real'; val: number }
    | { tag: 'text'; val: string }
    | { tag: 'blob'; val: Uint8Array };

  export type SqlError = { tag: string; val?: string };
  export type Row = Array<[string, SqlValue]>;

  export class Connection {
    run(sql: string, params: SqlValue[]): { tag: 'ok'; val: bigint | number } | { tag: 'err'; val: SqlError };
    query(sql: string, params: SqlValue[]): { tag: 'ok'; val: Row[] } | { tag: 'err'; val: SqlError };
    first(sql: string, params: SqlValue[]): { tag: 'ok'; val: Row | null } | { tag: 'err'; val: SqlError };
    exec(sql: string): { tag: 'ok'; val?: undefined } | { tag: 'err'; val: SqlError };
    close(): { tag: 'ok'; val?: undefined } | { tag: 'err'; val: SqlError };
  }

  export function open(path: string): { tag: 'ok'; val: Connection } | { tag: 'err'; val: SqlError };
}

declare module 'wasi:cli/environment@0.3.0' {
  export function getEnvironment(): Array<[string, string]>;
}
