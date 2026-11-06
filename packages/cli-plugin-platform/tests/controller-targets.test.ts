import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import { parseAppCommandArgs } from '../src/args';
import { createWasmcloudCommand } from '../src/command';
import {
  authorizationUrl,
  base64url,
  bearer,
  CliError,
  ControllerError,
  type Credential,
  caPem,
  createClient,
  discover,
  events,
  exchangeCode,
  home,
  load,
  needsRefresh,
  OidcError,
  parseAccountCommandArgs,
  parseConfigArgs,
  parseLoginArgs,
  parseLogsArgs,
  pkce,
  randomToken,
  readCaFile,
  readStore,
  refreshCredential,
  refreshTokens,
  registryOrigin,
  registryUsername,
  resolveAccount,
  resolveControllerSession,
  revokeToken,
  runWasmcloudLogin,
  runWasmcloudLogout,
  runWasmcloudLogs,
  runWasmcloudSecrets,
  runWasmcloudVars,
  runWasmcloudWhoami,
  tlsTrustCode,
  trusting,
  wrapControllerError,
  writeStore,
} from '../src/controller';
import { runWasmcloudDeploy } from '../src/deploy';
import type { WasmcloudDeps } from '../src/deps';
import { runWasmcloudDestroy } from '../src/destroy';
import { parseDeployManifest } from '../src/manifest';
import {
  parseServiceCreateArgs,
  parseServiceNameArgs,
  runWasmcloudServiceCreate,
  runWasmcloudServiceDelete,
} from '../src/service';
import {
  discoverAccountControllerUrl,
  isControllerBackedTarget,
  resolveConnection,
  resolveTarget,
} from '../src/target';
import {
  captureIo,
  expectFailure,
  fakeDeps,
  makeWorkspace,
  type RunnerInvocation,
} from './helpers';

const SAMPLE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBszCCAVmgAwIBAgIUSampleCertData1234567890==',
  '-----END CERTIFICATE-----',
].join('\n');

const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;

function makeControllerDeps(
  options: Parameters<typeof fakeDeps>[0] & {
    fetch?: typeof fetch;
    openBrowser?: (url: string) => void;
    loginTimeoutMs?: number;
    stdin?: () => string;
    onOrasConfig?: (configPath: string, content: string, mode: number) => void;
  },
): WasmcloudDeps {
  const base = fakeDeps(options);
  const pushedRefs = new Set<string>();
  const descriptorJson = JSON.stringify({
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: MANIFEST_DIGEST,
    size: 512,
  });

  const inspectConfig = (args: readonly string[]) => {
    const idx = args.indexOf('--registry-config');
    if (idx >= 0) {
      const configPath = args[idx + 1];
      if (configPath && existsSync(configPath)) {
        options.onOrasConfig?.(
          configPath,
          readFileSync(configPath, 'utf8'),
          statSync(configPath).mode & 0o777,
        );
      }
    }
  };

  return {
    ...base,
    fetch: options.fetch,
    openBrowser: options.openBrowser,
    loginTimeoutMs: options.loginTimeoutMs,
    stdin: options.stdin,
    runner: async (command, args, runOptions) => {
      if (command === 'oras' && args[0] === 'push') {
        inspectConfig(args);
        const ref = args[args.length - 2];
        if (ref) pushedRefs.add(ref);
      }
      return base.runner(command, args, runOptions);
    },
    runCaptured: async (command, args, runOptions) => {
      const result = await base.runCaptured(command, args, runOptions);
      if (command === 'oras' && args[0] === 'manifest' && args[1] === 'fetch') {
        inspectConfig(args);
        const ref = args[args.length - 1] ?? '';
        if (pushedRefs.has(ref)) {
          return { exitCode: 0, stdout: descriptorJson, stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      return result;
    },
  };
}

describe('target helpers for account and controller targets', () => {
  it('identifies controller-backed targets, discovers controller URLs, and rejects resolveConnection', async () => {
    const manifest = parseDeployManifest(
      '/workspace/di-framework.deploy.toml',
      `[targets.acct]
account = "acme"

[targets.ctrl]
controller = "https://acme.controller.example.com"

[targets.local]
platform = "deploy/platform"
`,
      {},
    );
    const acct = resolveTarget(manifest, 'acct');
    const ctrl = resolveTarget(manifest, 'ctrl');
    const local = resolveTarget(manifest, 'local');

    expect(isControllerBackedTarget(acct)).toBe(true);
    expect(isControllerBackedTarget(ctrl)).toBe(true);
    expect(isControllerBackedTarget(local)).toBe(false);

    expect(discoverAccountControllerUrl('acme')).toBe('https://acme.controller.localhost');
    expect(discoverAccountControllerUrl('acme', 'authproto.internal:8443')).toBe(
      'https://acme.controller.authproto.internal:8443',
    );
    expect(
      discoverAccountControllerUrl('acme', undefined, { DI_PLATFORM_DOMAIN: 'example.com' }),
    ).toBe('https://acme.controller.example.com');

    const deps = fakeDeps({ cwd: '/workspace' });
    await expect(resolveConnection(acct, '/workspace', manifest.path, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_TARGET_INVALID_KIND',
      exitCode: 2,
    });
  });
});

describe('SSE parser and typed /v1 client', () => {
  it('parses text/event-stream frames with comments, ids, multi-line data, and trailing lines', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            ': keepalive\nid: 1\nevent: log\ndata: first\ndata: second\nfieldwithoutcolon\n\n',
          ),
        );
        controller.enqueue(encoder.encode('data: trailing-without-newline'));
        controller.close();
      },
    });
    const collected = [];
    for await (const ev of events(stream)) {
      collected.push(ev);
    }
    expect(collected).toEqual([
      { id: '1', event: 'log', data: 'first\nsecond' },
      { data: 'trailing-without-newline' },
    ]);
  });

  it('calls every /v1 client endpoint and maps error responses to ControllerError', async () => {
    const calls: { method: string; url: string; auth?: string | null; body?: string }[] = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? 'GET',
        url,
        auth: headers.get('authorization'),
        body: init?.body ? String(init.body) : undefined,
      });

      if (url.endsWith('/v1/auth/info')) {
        return Response.json({
          account: 'acme',
          issuer: 'https://id.example.com',
          clientId: 'cli',
        });
      }
      if (url.endsWith('/v1/auth/whoami')) {
        return Response.json({
          user: 'alice@example.com',
          account: 'acme',
          role: 'developer',
          via: 'api-key',
        });
      }
      if (url.endsWith('/v1/auth/logout')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/deploy/preview')) {
        return Response.json({
          env: 'prod',
          service: 'greeter',
          changes: [{ kind: 'create', resource: 'WorkloadDeployment', name: 'greeter-prod' }],
        });
      }
      if (url.endsWith('/v1/deploy')) {
        return Response.json(
          {
            id: 'dep-1',
            service: 'greeter',
            env: 'prod',
            status: 'rolling',
            component: { reference: 'reg/greeter:1', digest: MANIFEST_DIGEST },
            createdAt: '2026-01-01T00:00:00Z',
          },
          { status: 202 },
        );
      }
      if (url.endsWith('/v1/deploy/registry')) {
        return Response.json({
          url: 'https://registry.example.com',
          repositoryPrefix: 'acme',
          auth: 'basic-identity',
          username: 'token',
        });
      }
      if (url.endsWith('/v1/services') && init?.method === 'POST') {
        return Response.json(
          {
            name: 'cache',
            env: 'prod',
            type: 'keyvalue',
            className: 'keyvalue-redis',
            createdAt: '2026-01-01T00:00:00Z',
          },
          { status: 201 },
        );
      }
      if (url.includes('/v1/services/cache/proxy')) {
        return Response.json(
          {
            url: 'https://acme.controller.example.com/proxy/1',
            port: 80,
            expiresAt: '2026-01-01T01:00:00Z',
          },
          { status: 201 },
        );
      }
      if (url.includes('/v1/services/empty-logs/logs')) {
        return new Response(null, { status: 200 });
      }
      if (url.includes('/v1/services/greeter/logs')) {
        const sseBody =
          'event: log\ndata: {"timestamp":"2026-01-01T00:00:00Z","deployment":"dep-1","level":"info","message":"hello"}\n\nevent: ignored\ndata: {}\n\nevent: end\ndata: {}\n\n';
        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.includes('/v1/deployments/stats')) {
        return Response.json({
          env: 'prod',
          services: 1,
          deployments: 2,
          ready: 1,
          failed: 0,
        });
      }
      if (url.includes('/v1/deployments/rollback')) {
        return Response.json(
          {
            id: 'dep-2',
            service: 'greeter',
            env: 'prod',
            status: 'rolling',
            component: { reference: 'reg/greeter:1', digest: MANIFEST_DIGEST },
            createdAt: '2026-01-01T00:00:00Z',
            rollbackOf: 'dep-1',
          },
          { status: 202 },
        );
      }
      if (url.includes('/v1/deployments/greeter') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/v1/deployments?')) {
        return Response.json({ items: [] });
      }
      if (url.includes('/v1/services/cache') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/v1/secrets?')) {
        return Response.json({
          env: 'prod',
          items: [{ name: 'db', updatedAt: '2026-01-01T00:00:00Z' }],
        });
      }
      if (url.includes('/v1/secrets/db')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/v1/vars?')) {
        return Response.json({
          env: 'prod',
          items: [{ name: 'LOG_LEVEL', value: 'debug', updatedAt: '2026-01-01T00:00:00Z' }],
        });
      }
      if (url.includes('/v1/vars/EMPTY_BODY') && init?.method === 'DELETE') {
        return new Response('', { status: 204 });
      }
      if (url.includes('/v1/vars/LOG_LEVEL') && init?.method === 'DELETE') {
        return Response.json({
          warnings: [{ code: 'referenced', detail: 'used by greeter', deployments: ['greeter'] }],
        });
      }
      if (url.includes('/v1/vars/LOG_LEVEL')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/v1/secrets/problem-error')) {
        return Response.json(
          { title: 'Conflict', status: 409, detail: 'secret is in use' },
          { status: 409 },
        );
      }
      return new Response('plain error', { status: 502 });
    }) as typeof fetch;

    const client = createClient({
      baseUrl: 'https://acme.controller.example.com/',
      token: 'dik_test',
      fetch: mockFetch,
    });

    expect((await client.authInfo()).account).toBe('acme');
    expect((await client.whoami()).user).toBe('alice@example.com');
    await client.logout();

    const sampleBundle = {
      env: 'prod' as const,
      service: 'greeter',
      component: { reference: 'reg/greeter:1', digest: MANIFEST_DIGEST },
      workload: {},
      bindings: [],
      secrets: [],
    };
    expect((await client.previewDeploy(sampleBundle)).changes).toHaveLength(1);
    expect((await client.deploy(sampleBundle)).id).toBe('dep-1');
    expect((await client.registry()).username).toBe('token');
    expect(
      (await client.createService({ env: 'prod', type: 'keyvalue', name: 'cache' })).name,
    ).toBe('cache');
    expect((await client.proxy('cache', { env: 'prod' })).port).toBe(80);

    const logItems = [];
    for await (const entry of client.logs('greeter', { env: 'prod', tail: 10 })) {
      logItems.push(entry);
    }
    expect(logItems).toHaveLength(1);

    const emptyLogs = [];
    for await (const entry of client.logs('empty-logs', { env: 'prod' })) {
      emptyLogs.push(entry);
    }
    expect(emptyLogs).toHaveLength(0);

    expect((await client.deployments({ env: 'prod' })).items).toEqual([]);
    expect((await client.deploymentStats('prod')).services).toBe(1);
    expect((await client.rollback({ env: 'prod', service: 'greeter' })).rollbackOf).toBe('dep-1');
    await client.removeDeployment('prod', 'greeter');
    await client.deleteService('prod', 'cache');

    expect((await client.secrets('prod')).items).toHaveLength(1);
    await client.setSecret('prod', 'db', 's3cr3t');
    await client.updateSecret('prod', 'db', 's3cr3t2');
    await client.unsetSecret('prod', 'db');

    expect((await client.vars('prod')).items).toHaveLength(1);
    await client.setVar('prod', 'LOG_LEVEL', 'info');
    await client.updateVar('prod', 'LOG_LEVEL', 'debug');
    expect((await client.unsetVar('prod', 'LOG_LEVEL')).warnings).toHaveLength(1);
    expect((await client.unsetVar('prod', 'EMPTY_BODY')).warnings).toEqual([]);

    await expect(client.unsetSecret('prod', 'problem-error')).rejects.toThrow('secret is in use');
    await expect(client.unsetSecret('prod', 'plain-error')).rejects.toThrow(
      'controller answered 502',
    );
    expect(calls.length).toBeGreaterThan(15);
  });
});

describe('OIDC, trust, registry, and credential helpers', () => {
  it('validates OIDC discovery, PKCE, token exchange, refresh, and revocation', async () => {
    expect(base64url(new Uint8Array([1, 2, 3]))).toBe('AQID');
    expect(randomToken(16).length).toBeGreaterThan(10);
    const pair = await pkce('fixed-verifier');
    expect(pair.verifier).toBe('fixed-verifier');
    expect(pair.challenge.length).toBeGreaterThan(10);

    const validMeta = {
      issuer: 'https://id.example.com',
      authorization_endpoint: 'https://id.example.com/authorize',
      token_endpoint: 'https://id.example.com/token',
      revocation_endpoint: 'https://id.example.com/revoke',
    };

    const oidcFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('bad-status')) return new Response('err', { status: 500 });
      if (url.includes('missing-field'))
        return Response.json({ issuer: 'https://missing-field.com' });
      if (url.includes('wrong-issuer')) {
        return Response.json({
          ...validMeta,
          issuer: 'https://other.example.com',
        });
      }
      if (url.includes('wrong-origin')) {
        return Response.json({
          issuer: 'https://wrong-origin.com',
          authorization_endpoint: 'https://evil.example.com/authorize',
          token_endpoint: 'https://wrong-origin.com/token',
        });
      }
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json(validMeta);
      }
      if (url.endsWith('/token')) {
        const body = String(init?.body ?? '');
        if (body.includes('bad-code')) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        if (body.includes('plain-fail')) {
          return new Response('broken', { status: 502 });
        }
        return Response.json({
          access_token: 'acc-1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'ref-1',
        });
      }
      if (url.endsWith('/revoke') || url.endsWith('/oauth2/revoke')) {
        const body = String(init?.body ?? '');
        if (body.includes('fail-revoke')) return new Response('no', { status: 500 });
        return new Response(null, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const meta = await discover('https://id.example.com/', oidcFetch);
    expect(meta.issuer).toBe('https://id.example.com');
    const authUrl = authorizationUrl(meta, {
      clientId: 'cli',
      redirectUri: 'http://127.0.0.1:9999/callback',
      scope: 'openid',
      state: 'st',
      nonce: 'nc',
      codeChallenge: pair.challenge,
    });
    expect(authUrl).toContain('code_challenge_method=S256');

    await expect(discover('https://bad-status.com', oidcFetch)).rejects.toThrow(OidcError);
    await expect(discover('https://missing-field.com', oidcFetch)).rejects.toThrow(
      'lacks authorization_endpoint',
    );
    await expect(discover('https://wrong-issuer.com', oidcFetch)).rejects.toThrow(
      'names a different issuer',
    );
    await expect(discover('https://wrong-origin.com', oidcFetch)).rejects.toThrow(
      'is not under the issuer',
    );

    const exchanged = await exchangeCode(
      meta,
      {
        clientId: 'cli',
        redirectUri: 'http://127.0.0.1:9999/callback',
        code: 'ok-code',
        codeVerifier: pair.verifier,
      },
      oidcFetch,
    );
    expect(exchanged.access_token).toBe('acc-1');

    const refreshed = await refreshTokens(
      meta,
      { clientId: 'cli', refreshToken: 'ref-0' },
      oidcFetch,
    );
    expect(refreshed.refresh_token).toBe('ref-1');

    await expect(
      exchangeCode(
        meta,
        {
          clientId: 'cli',
          redirectUri: 'http://127.0.0.1:9999/callback',
          code: 'bad-code',
          codeVerifier: pair.verifier,
        },
        oidcFetch,
      ),
    ).rejects.toThrow('invalid_grant');

    await expect(
      refreshTokens(meta, { clientId: 'cli', refreshToken: 'plain-fail' }, oidcFetch),
    ).rejects.toThrow('502');

    await revokeToken(meta, 'cli', 'ref-1', oidcFetch);
    await revokeToken({ ...meta, revocation_endpoint: undefined }, 'cli', 'ref-1', oidcFetch);
    await expect(
      revokeToken(
        { ...meta, revocation_endpoint: 'https://evil.example.com/revoke' },
        'cli',
        'ref-1',
        oidcFetch,
      ),
    ).rejects.toThrow('not on the issuer origin');
    await expect(revokeToken(meta, 'cli', 'fail-revoke', oidcFetch)).rejects.toThrow(
      'revocation endpoint returned 500',
    );
  });

  it('validates CA trust files, registry origins, and usernames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-trust-'));
    const pemPath = join(dir, 'ca.pem');
    const emptyPath = join(dir, 'empty.txt');
    writeFileSync(pemPath, SAMPLE_PEM);
    writeFileSync(emptyPath, 'no certificate here\n');

    const b64 = readCaFile(pemPath);
    expect(caPem({ url: 'https://x', certificateAuthorityData: b64 })).toContain(
      'BEGIN CERTIFICATE',
    );
    expect(caPem({ url: 'https://x' })).toBeUndefined();
    expect(() => readCaFile(join(dir, 'missing.pem'))).toThrow('--ca-file');
    expect(() => readCaFile(emptyPath)).toThrow('holds no PEM certificate');

    let passedInit: RequestInit | undefined;
    const baseFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      passedInit = init;
      return new Response('ok');
    }) as typeof fetch;
    expect(trusting(baseFetch, undefined)).toBe(baseFetch);
    const wrapped = trusting(baseFetch, SAMPLE_PEM);
    await wrapped?.('https://example.com');
    expect((passedInit as { tls?: { ca?: string[] } } | undefined)?.tls?.ca).toContain(SAMPLE_PEM);

    expect(registryOrigin('https://registry.example.com:5000')).toEqual({
      origin: 'https://registry.example.com:5000',
      host: 'registry.example.com:5000',
      plainHttp: false,
    });
    expect(registryOrigin('http://localhost:5000')).toEqual({
      origin: 'http://localhost:5000',
      host: 'localhost:5000',
      plainHttp: true,
    });
    expect(registryOrigin('http://127.0.0.1:5000').plainHttp).toBe(true);
    expect(registryOrigin('http://[::1]:5000').plainHttp).toBe(true);
    expect(registryOrigin('http://reg.ns.svc:5000').plainHttp).toBe(true);
    expect(registryOrigin('http://reg.ns.svc.cluster.local:5000').plainHttp).toBe(true);

    for (const bad of [
      'not-a-url',
      'ftp://registry.example.com',
      'https://user:pass@registry.example.com',
      'https://registry.example.com/v2',
      'https://bad_host.example.com',
      'http://registry.example.com',
    ]) {
      expect(() => registryOrigin(bad)).toThrow(CliError);
    }

    expect(registryUsername('token')).toBe('token');
    expect(() => registryUsername('-flag')).toThrow(CliError);
    expect(() => registryUsername('bad:user')).toThrow(CliError);
  });

  it('manages credential store, token refresh, and resolveControllerSession for account and controller targets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-creds-'));
    const env = { DI_FRAMEWORK_HOME: join(dir, 'home') };
    expect(home(env)).toBe(join(dir, 'home'));
    expect(home({})).toContain('.di-framework');
    expect(readStore(env)).toEqual({});

    const expiringCred: Credential = {
      account: 'acme',
      user: 'alice@example.com',
      role: 'developer',
      via: 'identity',
      accessToken: 'old-token',
      refreshToken: 'ref-token',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      issuer: 'https://id.example.com',
      clientId: 'cli',
      controller: { url: 'https://acme.controller.example.com' },
    };
    expect(needsRefresh(expiringCred)).toBe(true);
    expect(needsRefresh({ ...expiringCred, accessToken: undefined })).toBe(true);
    expect(needsRefresh({ ...expiringCred, via: 'api-key', apiKey: 'dik_1' })).toBe(false);

    writeStore({ acme: expiringCred }, env);
    expect(readStore(env).acme?.user).toBe('alice@example.com');

    expect(bearer({ ...expiringCred, via: 'api-key', apiKey: 'dik_1' })).toBe('dik_1');
    expect(() => bearer({ ...expiringCred, accessToken: undefined })).toThrow('holds no token');
    expect(() =>
      bearer({ ...expiringCred, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ).toThrow('expired');

    expect(resolveAccount('acme', {}, {})).toBe('acme');
    expect(resolveAccount(undefined, { DI_TENANT_ACCOUNT: 'acme' }, {})).toBe('acme');
    expect(resolveAccount(undefined, {}, { acme: expiringCred })).toBe('acme');
    expect(() => resolveAccount(undefined, {}, {})).toThrow('not logged in');
    expect(() =>
      resolveAccount(
        undefined,
        {},
        { acme: expiringCred, beta: { ...expiringCred, account: 'beta' } },
      ),
    ).toThrow('--account <tenant> is required');
    expect(() => load('missing', env)).toThrow('not logged in to missing');

    await expect(refreshCredential({ ...expiringCred, issuer: undefined })).rejects.toThrow(
      'cannot be refreshed',
    );

    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
        });
      }
      if (url.endsWith('/token')) {
        return Response.json({
          access_token: 'refreshed-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refreshed-refresh-token',
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const acctSession = await resolveControllerSession(
      {
        target: { kind: 'account', name: 'prod', account: 'acme', domain: 'custom.example.com' },
      },
      { env, fetch: mockFetch },
    );
    expect(acctSession.credential.accessToken).toBe('refreshed-access-token');
    expect(acctSession.credential.controller.url).toBe(
      'https://acme.controller.custom.example.com',
    );
    expect(readStore(env).acme?.accessToken).toBe('refreshed-access-token');

    const acctDefaultDomainSession = await resolveControllerSession(
      {
        target: { kind: 'account', name: 'prod', account: 'acme' },
      },
      { env, fetch: mockFetch },
    );
    expect(acctDefaultDomainSession.credential.controller.url).toBe(
      'https://acme.controller.example.com',
    );

    await expect(
      resolveControllerSession(
        { target: { kind: 'account', name: 'missing', account: 'unknown' } },
        { env, fetch: mockFetch },
      ),
    ).rejects.toThrow('not logged in to unknown');

    const ctrlExplicitSession = await resolveControllerSession(
      {
        target: {
          kind: 'controller',
          name: 'direct',
          controller: 'https://acme.controller.example.com',
          account: 'acme',
        },
      },
      { env, fetch: mockFetch },
    );
    expect(ctrlExplicitSession.credential.account).toBe('acme');

    await expect(
      resolveControllerSession(
        {
          target: {
            kind: 'controller',
            name: 'direct',
            controller: 'https://acme.controller.example.com',
            account: 'nobody',
          },
        },
        { env, fetch: mockFetch },
      ),
    ).rejects.toThrow('not logged in to nobody');

    const ctrlMatchedSession = await resolveControllerSession(
      {
        target: {
          kind: 'controller',
          name: 'direct',
          controller: 'https://acme.controller.example.com',
        },
      },
      { env, fetch: mockFetch },
    );
    expect(ctrlMatchedSession.credential.account).toBe('acme');

    const ctrlFallbackSession = await resolveControllerSession(
      {
        target: {
          kind: 'controller',
          name: 'other',
          controller: 'https://other.controller.example.com',
        },
      },
      { env, fetch: mockFetch },
    );
    expect(ctrlFallbackSession.credential.controller.url).toBe(
      'https://other.controller.example.com',
    );

    const noTargetSession = await resolveControllerSession(
      { account: 'acme', fresh: true },
      { env, fetch: mockFetch },
    );
    expect(noTargetSession.credential.account).toBe('acme');

    const failOidcFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
        });
      }
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }) as unknown as typeof fetch;
    await expect(refreshCredential(expiringCred, failOidcFetch)).rejects.toThrow(
      'the login has expired',
    );

    const networkFailFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
        });
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(refreshCredential(expiringCred, networkFailFetch)).rejects.toThrow('network down');
  });
});

describe('login, whoami, logout, deploy, destroy, service, logs, secrets, and vars over /v1', () => {
  it('supports API key login, browser PKCE login, whoami, and logout', async () => {
    const { root } = makeWorkspace({
      manifest: `default-target = "authproto"

[targets.authproto]
account = "acme"
domain = "authproto.example.com"

[targets.authproto-nodomain]
account = "acme"

[targets.direct]
controller = "https://acme.controller.authproto.example.com"

[targets.direct-acct]
controller = "https://acme.controller.authproto.example.com"
account = "acme"

[targets.direct-unmatched]
controller = "https://unmatched.controller.authproto.example.com"

[targets.local]
platform = "deploy/platform"
`,
    });
    const homeDir = mkdtempSync(join(tmpdir(), 'platform-auth-home-'));
    const caPath = join(homeDir, 'ca.pem');
    writeFileSync(caPath, SAMPLE_PEM);
    const env = { DI_FRAMEWORK_HOME: homeDir };

    let logoutCalled = 0;
    let revokeCalled = 0;
    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/info')) {
        return Response.json({
          account: 'acme',
          issuer: 'https://id.authproto.example.com',
          clientId: 'di-cli',
        });
      }
      if (url.endsWith('/v1/auth/whoami')) {
        return Response.json({
          user: 'dev@acme.io',
          account: 'acme',
          role: 'developer',
          via: 'identity',
        });
      }
      if (url.endsWith('/v1/auth/logout')) {
        logoutCalled += 1;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: 'https://id.authproto.example.com',
          authorization_endpoint: 'https://id.authproto.example.com/authorize',
          token_endpoint: 'https://id.authproto.example.com/token',
          revocation_endpoint: 'https://id.authproto.example.com/revoke',
        });
      }
      if (url.endsWith('/token')) {
        return Response.json({
          access_token: 'oidc-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'oidc-refresh-token',
        });
      }
      if (url.endsWith('/revoke')) {
        revokeCalled += 1;
        return new Response(null, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const { io } = captureIo();
    const apiKeyDeps = makeControllerDeps({ cwd: root, env, fetch: mockFetch });
    const apiKeyResult = await runWasmcloudLogin(
      ['--target', 'authproto', '--api-key', 'dik_secret', '--ca-file', caPath],
      io,
      apiKeyDeps,
    );
    expect(apiKeyResult.data).toMatchObject({
      account: 'acme',
      user: 'dev@acme.io',
      via: 'api-key',
      controller: 'https://acme.controller.authproto.example.com',
    });

    const whoResult = await runWasmcloudWhoami(['--target', 'direct'], io, apiKeyDeps);
    expect(whoResult.text).toContain('dev@acme.io (developer) in acme');

    // Whoami without --target uses default-target ('authproto')
    const whoDefaultResult = await runWasmcloudWhoami([], io, apiKeyDeps);
    expect(whoDefaultResult.text).toContain('dev@acme.io (developer) in acme');

    const browserDeps = makeControllerDeps({
      cwd: root,
      env,
      fetch: mockFetch,
      openBrowser: (authUrl) => {
        const parsed = new URL(authUrl);
        const redirectUri = parsed.searchParams.get('redirect_uri') as string;
        const state = parsed.searchParams.get('state') as string;
        void fetch(new URL('/not-found', redirectUri));
        void fetch(`${redirectUri}?code=test-auth-code&state=${state}`);
      },
    });
    const browserLoginResult = await runWasmcloudLogin(['--target', 'direct'], io, browserDeps);
    expect(browserLoginResult.data).toMatchObject({
      account: 'acme',
      via: 'identity',
    });

    const logoutResult = await runWasmcloudLogout(['--target', 'direct'], io, browserDeps);
    expect(logoutResult.data).toEqual({ account: 'acme', loggedOut: true });
    expect(logoutCalled).toBe(1);
    expect(revokeCalled).toBe(1);
    expect(readStore(env)).toEqual({});

    // Re-login and logout via account target without domain, controller target with account, and unmatched controller target
    await runWasmcloudLogin(
      ['--target', 'authproto-nodomain', '--api-key', 'dik_secret'],
      io,
      apiKeyDeps,
    );
    expect((await runWasmcloudLogout(['--target', 'authproto'], io, apiKeyDeps)).data).toEqual({
      account: 'acme',
      loggedOut: true,
    });
    await runWasmcloudLogin(['--target', 'direct-acct', '--api-key', 'dik_secret'], io, apiKeyDeps);
    expect((await runWasmcloudLogout(['--target', 'direct-acct'], io, apiKeyDeps)).data).toEqual({
      account: 'acme',
      loggedOut: true,
    });
    await runWasmcloudLogin(['--target', 'authproto', '--api-key', 'dik_secret'], io, apiKeyDeps);
    expect(
      (await runWasmcloudLogout(['--target', 'direct-unmatched'], io, apiKeyDeps)).data,
    ).toEqual({
      account: 'acme',
      loggedOut: true,
    });
    // Whoami and logout when not logged in wrap CliError (including in workspace with managed default-target)
    const managedDefaultWs = makeWorkspace();
    const managedDeps = makeControllerDeps({ cwd: managedDefaultWs.root, env, fetch: mockFetch });
    await expect(runWasmcloudWhoami([], io, managedDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROLLER_AUTH_REQUIRED',
    });
    await expect(runWasmcloudLogout([], io, managedDeps)).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROLLER_AUTH_REQUIRED',
    });
  });

  it('handles browser login errors, timeout, account mismatch, and logout revocation warnings', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'platform-auth-err-'));
    const env = { DI_FRAMEWORK_HOME: homeDir };
    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/info')) {
        return Response.json({
          account: 'acme',
          issuer: 'https://id.example.com',
          clientId: 'di-cli',
        });
      }
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: 'https://id.example.com',
          authorization_endpoint: 'https://id.example.com/authorize',
          token_endpoint: 'https://id.example.com/token',
          revocation_endpoint: 'https://id.example.com/revoke',
        });
      }
      if (url.endsWith('/v1/auth/logout')) {
        return new Response('expired', { status: 401 });
      }
      if (url.endsWith('/revoke')) {
        return new Response('failed', { status: 500 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const { io, stderr } = captureIo();

    // Account mismatch
    await expect(
      runWasmcloudLogin(
        [
          '--controller',
          'https://acme.controller.example.com',
          '--account',
          'other',
          '--api-key',
          'k',
        ],
        io,
        makeControllerDeps({ cwd: homeDir, env, fetch: mockFetch }),
      ),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_CONTROLLER_AUTH_REQUIRED' });

    // OAuth error callback
    await expect(
      runWasmcloudLogin(
        ['--account', 'acme', '--no-ca'],
        io,
        makeControllerDeps({
          cwd: homeDir,
          env,
          fetch: mockFetch,
          openBrowser: (authUrl) => {
            const redirectUri = new URL(authUrl).searchParams.get('redirect_uri') as string;
            void fetch(`${redirectUri}?error=access_denied`);
          },
        }),
      ),
    ).rejects.toThrow('access_denied');

    // State mismatch callback
    await expect(
      runWasmcloudLogin(
        ['--controller', 'https://acme.controller.example.com'],
        io,
        makeControllerDeps({
          cwd: homeDir,
          env,
          fetch: mockFetch,
          openBrowser: (authUrl) => {
            const redirectUri = new URL(authUrl).searchParams.get('redirect_uri') as string;
            void fetch(`${redirectUri}?code=abc&state=wrong`);
          },
        }),
      ),
    ).rejects.toThrow('unexpected login response');

    // Timeout with --no-browser
    await expect(
      runWasmcloudLogin(
        ['--controller', 'https://acme.controller.example.com', '--no-browser'],
        io,
        makeControllerDeps({
          cwd: homeDir,
          env,
          fetch: mockFetch,
          loginTimeoutMs: 25,
        }),
      ),
    ).rejects.toThrow('timed out waiting for the browser login');

    // Logout when revocation fails still removes the credential and logs a warning
    writeStore(
      {
        acme: {
          account: 'acme',
          user: 'dev@acme.io',
          role: 'developer',
          via: 'identity',
          accessToken: 'tok',
          refreshToken: 'ref',
          issuer: 'https://id.example.com',
          clientId: 'di-cli',
          controller: { url: 'https://acme.controller.example.com' },
        },
      },
      env,
    );
    await runWasmcloudLogout(
      ['--account', 'acme'],
      io,
      makeControllerDeps({ cwd: homeDir, env, fetch: mockFetch }),
    );
    expect(stderr.join('')).toContain('warning: failed to revoke token');
    expect(readStore(env)).toEqual({});
  });

  it('deploys, previews, destroys, and manages services, logs, secrets, and vars over /v1', async () => {
    const { greeter } = makeWorkspace({
      manifest: `default-target = "authproto"

[targets.authproto]
account = "acme"
domain = "authproto.example.com"
env = "prod"
secrets = ["api-secret"]

[targets.direct]
controller = "https://acme.controller.authproto.example.com"
account = "acme"

[targets.development]
kubeconfig = "/tmp/kubeconfig"
namespace = "wasmcloud"
registry = "registry.example.com/team"
`,
    });
    // Add a scheduled cron job to greeter to exercise cron job reporting on controller deploy
    writeFileSync(
      join(greeter, 'src', 'app.ts'),
      `const Cron = (_s: string) => (_t: unknown, _k: string) => {};
export class Jobs {
  @Cron('0 * * * *')
  hourly() {}
}
export default () => new Response('ok');
`,
    );

    const homeDir = mkdtempSync(join(tmpdir(), 'platform-deploy-home-'));
    const env = { DI_FRAMEWORK_HOME: homeDir };
    writeStore(
      {
        acme: {
          account: 'acme',
          user: 'dev@acme.io',
          role: 'developer',
          via: 'api-key',
          apiKey: 'dik_live_token',
          controller: { url: 'https://acme.controller.authproto.example.com' },
        },
      },
      env,
    );

    let capturedBundle: unknown;
    let capturedServiceCreate: unknown;
    let deletedService: { env: string; name: string } | undefined;
    let removedDeployment: { env: string; service: string } | undefined;
    let orasAuthConfig = '';
    let orasAuthMode = 0;

    let registryPrefix: string | undefined = 'acme';
    let previewChanges: Array<{
      kind: 'create' | 'update' | 'noop';
      resource: string;
      name: string;
    }> = [{ kind: 'update', resource: 'WorkloadDeployment', name: 'greeter-staging' }];
    let failNextControllerCall = false;

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (failNextControllerCall) {
        failNextControllerCall = false;
        return Response.json({ title: 'Internal Error', detail: 'boom' }, { status: 500 });
      }
      if (url.pathname === '/v1/auth/info') {
        return Response.json({
          account: 'acme',
          issuer: 'https://id.authproto.example.com',
          clientId: 'di-cli',
        });
      }
      if (url.pathname === '/v1/auth/whoami') {
        return Response.json({
          user: 'dev@acme.io',
          account: 'acme',
          role: 'developer',
          via: 'api-key',
        });
      }
      if (url.pathname === '/v1/auth/logout') {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/v1/deploy/registry') {
        return Response.json({
          url: 'https://registry.authproto.example.com',
          ...(registryPrefix ? { repositoryPrefix: registryPrefix } : {}),
          auth: 'basic-identity',
          username: 'token',
        });
      }
      if (url.pathname === '/v1/deploy/preview') {
        capturedBundle = JSON.parse(String(init?.body));
        return Response.json({
          env: 'staging',
          service: 'greeter',
          changes: previewChanges,
        });
      }
      if (url.pathname === '/v1/deploy') {
        capturedBundle = JSON.parse(String(init?.body));
        return Response.json(
          {
            id: 'dep-42',
            service: 'greeter',
            env: 'prod',
            status: 'rolling',
            component: (capturedBundle as { component: unknown }).component,
            createdAt: '2026-01-01T00:00:00Z',
          },
          { status: 202 },
        );
      }
      if (url.pathname === '/v1/deployments/greeter' && init?.method === 'DELETE') {
        removedDeployment = { env: url.searchParams.get('env') ?? '', service: 'greeter' };
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/v1/services' && init?.method === 'POST') {
        capturedServiceCreate = JSON.parse(String(init?.body));
        const body = capturedServiceCreate as {
          name: string;
          env: 'prod' | 'staging';
          type: 'keyvalue' | 'egress';
          className?: string;
          parameters?: Record<string, string>;
          deletionPolicy?: 'Retain' | 'Delete';
          destinations?: string[];
        };
        return Response.json(
          {
            name: body.name,
            env: body.env,
            type: body.type,
            className: body.className ?? 'keyvalue-redis',
            parameters: body.parameters,
            deletionPolicy: body.deletionPolicy,
            destinations: body.destinations,
            createdAt: '2026-01-01T00:00:00Z',
          },
          { status: 201 },
        );
      }
      if (url.pathname === '/v1/services/cache' && init?.method === 'DELETE') {
        deletedService = { env: url.searchParams.get('env') ?? '', name: 'cache' };
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/v1/services/greeter/logs') {
        const sse =
          'event: log\ndata: {"timestamp":"2026-01-01T00:00:00Z","deployment":"dep-42","level":"info","message":"listening"}\n\nevent: end\ndata: {}\n\n';
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.pathname === '/v1/secrets' && init?.method === 'GET') {
        const qEnv = url.searchParams.get('env');
        return Response.json({
          env: qEnv,
          items:
            qEnv === 'staging' ? [] : [{ name: 'api-secret', updatedAt: '2026-01-01T00:00:00Z' }],
        });
      }
      if (url.pathname.startsWith('/v1/secrets/')) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/v1/vars' && init?.method === 'GET') {
        const qEnv = url.searchParams.get('env');
        return Response.json({
          env: qEnv,
          items:
            qEnv === 'staging'
              ? []
              : [{ name: 'LOG_LEVEL', value: 'info', updatedAt: '2026-01-01T00:00:00Z' }],
        });
      }
      if (url.pathname.startsWith('/v1/vars/') && init?.method === 'DELETE') {
        return Response.json({
          warnings: [
            {
              code: 'referenced',
              detail: 'greeter-prod injects LOG_LEVEL',
              deployments: ['greeter-prod'],
            },
          ],
        });
      }
      if (url.pathname.startsWith('/v1/vars/')) {
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const invocations: RunnerInvocation[] = [];
    const deps = makeControllerDeps({
      cwd: greeter,
      env,
      invocations,
      fetch: mockFetch,
      stdin: () => 'from-stdin-value\n',
      onOrasConfig: (_path, content, mode) => {
        orasAuthConfig = content;
        orasAuthMode = mode;
      },
    });
    const { io, stdout, stderr } = captureIo();

    // 1. Deploy to account target (with cron jobs, then without cron jobs)
    const deployResult = await runWasmcloudDeploy(['--target', 'authproto'], io, deps);
    expect(deployResult.data.deployment?.id).toBe('dep-42');
    expect(deployResult.data.account).toBe('acme');
    expect(deployResult.data.image).toContain('registry.authproto.example.com/acme/greeter:');
    expect(deployResult.text).toContain('Scheduled jobs (1): Jobs.hourly');
    expect(orasAuthMode).toBe(0o600);
    expect(orasAuthConfig).toContain(Buffer.from('token:dik_live_token').toString('base64'));
    expect(invocations.some((i) => i.command === 'kubectl')).toBe(false);

    writeFileSync(join(greeter, 'src', 'app.ts'), 'export default () => new Response("ok");\n');
    const noCronDeployResult = await runWasmcloudDeploy(['--target', 'authproto'], io, deps);
    expect(noCronDeployResult.data.cronJobs).toBeUndefined();

    // 2. Preview deploy to controller target with --env staging and no changes / with changes
    const previewResult = await runWasmcloudDeploy(
      ['--target', 'direct', '--env', 'staging', '--preview'],
      io,
      deps,
    );
    expect(previewResult.data.preview?.changes).toHaveLength(1);
    expect(previewResult.text).toContain('update WorkloadDeployment/greeter-staging');

    registryPrefix = undefined;
    previewChanges = [];
    const noChangePreview = await runWasmcloudDeploy(
      ['--target', 'direct', '--env', 'staging', '--preview'],
      io,
      deps,
    );
    expect(noChangePreview.text).toContain('no changes');

    // Controller error wrapping across deploy, destroy, service create, service delete, logs, secrets
    failNextControllerCall = true;
    await expect(runWasmcloudDeploy(['--target', 'authproto'], io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROLLER_ERROR',
    });
    failNextControllerCall = true;
    await expect(runWasmcloudDestroy(['--target', 'authproto'], io, deps)).rejects.toMatchObject({
      code: 'WASMCLOUD_CONTROLLER_ERROR',
    });
    failNextControllerCall = true;
    await expect(
      runWasmcloudServiceCreate(['keyvalue', '--name', 'cache', '--target', 'authproto'], io, deps),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_CONTROLLER_ERROR' });
    failNextControllerCall = true;
    await expect(
      runWasmcloudServiceDelete(['cache', '--target', 'authproto'], io, deps),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_CONTROLLER_ERROR' });
    failNextControllerCall = true;
    await expect(
      runWasmcloudLogs(['greeter', '--target', 'authproto'], io, deps),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_CONTROLLER_ERROR' });
    failNextControllerCall = true;
    await expect(
      runWasmcloudSecrets(['list', '--target', 'authproto'], io, deps),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_CONTROLLER_ERROR' });

    // Service create egress with destinations on controller target
    const egressSvc = await runWasmcloudServiceCreate(
      ['egress', 'stripe', '--destination', 'api.stripe.com:443', '--target', 'authproto'],
      io,
      deps,
    );
    expect(egressSvc.data.destinations).toEqual(['api.stripe.com:443']);

    // 3. Destroy deployment on account target
    const destroyResult = await runWasmcloudDestroy(
      ['--target', 'authproto', '--env', 'prod'],
      io,
      deps,
    );
    expect(removedDeployment).toEqual({ env: 'prod', service: 'greeter' });
    expect(destroyResult.text).toContain('Removed greeter from authproto (acme/prod).');

    // 4. Service create & delete on account target
    const createSvcResult = await runWasmcloudServiceCreate(
      [
        'keyvalue',
        '--name',
        'cache',
        '--target',
        'authproto',
        '--env',
        'prod',
        '--memory',
        '128Mi',
        '--deletion-policy',
        'Retain',
      ],
      io,
      deps,
    );
    expect(createSvcResult.data.name).toBe('cache');
    expect(createSvcResult.text).toContain('Created keyvalue service cache');

    const deleteSvcResult = await runWasmcloudServiceDelete(
      ['cache', '--target', 'authproto', '--env', 'prod'],
      io,
      deps,
    );
    expect(deletedService).toEqual({ env: 'prod', name: 'cache' });
    expect(deleteSvcResult.data.deleted).toBe(true);

    // 5. Logs (defaulting to current project service 'greeter')
    const logsResult = await runWasmcloudLogs(
      [
        '--target',
        'authproto',
        '--env',
        'prod',
        '--tail',
        '5',
        '--follow',
        '--since',
        '10m',
        '--deployment',
        'dep-42',
      ],
      io,
      deps,
    );
    expect(logsResult.text).toContain('dep-42 info listening');
    expect(stdout.join('')).toContain('listening');

    // 6. Secrets & Vars via command tree
    const secretFile = join(homeDir, 'secret.txt');
    writeFileSync(secretFile, 'file-secret-value\n');
    const cmd = createWasmcloudCommand(deps);

    const secretsList = await cmd.children?.secrets?.run?.({
      args: ['list', '--target', 'authproto'],
      command: ['platform', 'secrets'],
      io,
    });
    expect(secretsList?.text).toBe('api-secret');

    const secretsEmpty = await runWasmcloudSecrets(
      ['list', '--target', 'authproto', '--env', 'staging'],
      io,
      deps,
    );
    expect(secretsEmpty.text).toBe('no secrets in staging');

    await runWasmcloudSecrets(
      ['set', 'api-secret', '--from-file', secretFile, '--target', 'authproto'],
      io,
      deps,
    );
    await runWasmcloudSecrets(
      ['update', 'api-secret', '--from-file', '-', '--target', 'authproto'],
      io,
      deps,
    );
    await runWasmcloudSecrets(['unset', 'api-secret', '--target', 'authproto'], io, deps);

    const varsList = await cmd.children?.vars?.run?.({
      args: ['list', '--target', 'authproto'],
      command: ['platform', 'vars'],
      io,
    });
    expect(varsList?.text).toBe('LOG_LEVEL=info');

    const varsEmpty = await runWasmcloudVars(
      ['list', '--target', 'authproto', '--env', 'staging'],
      io,
      deps,
    );
    expect(varsEmpty.text).toBe('no vars in staging');

    await runWasmcloudVars(
      ['set', 'LOG_LEVEL', '--value', 'debug', '--target', 'authproto'],
      io,
      deps,
    );
    await runWasmcloudVars(
      ['update', 'LOG_LEVEL', '--value', 'trace', '--target', 'authproto'],
      io,
      deps,
    );
    const unsetVarRes = await runWasmcloudVars(
      ['unset', 'LOG_LEVEL', '--target', 'authproto'],
      io,
      deps,
    );
    expect(unsetVarRes.text).toBe('unset var LOG_LEVEL in prod');
    expect(stderr.join('')).toContain('warning: greeter-prod injects LOG_LEVEL');

    // Also invoke login, logout, whoami, logs through createWasmcloudCommand
    await cmd.children?.whoami?.run?.({
      args: ['--target', 'authproto'],
      command: ['platform', 'whoami'],
      io,
    });
    await cmd.children?.logs?.run?.({
      args: ['greeter', '--target', 'authproto'],
      command: ['platform', 'logs'],
      io,
    });
    await cmd.children?.login?.run?.({
      args: ['--target', 'authproto', '--api-key', 'dik_live_token'],
      command: ['platform', 'login'],
      io,
    });
    await cmd.children?.logout?.run?.({
      args: ['--target', 'authproto'],
      command: ['platform', 'logout'],
      io,
    });
  });

  it('validates argument parsers and error wrapping for controller commands', async () => {
    expect(parseAppCommandArgs(['--env', 'staging', '--preview'], 'platform deploy')).toEqual({
      name: undefined,
      target: undefined,
      env: 'staging',
      preview: true,
      yes: false,
    });
    expectFailure(
      () => parseAppCommandArgs(['--env', 'invalid'], 'platform deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parseAppCommandArgs(['--env', 'prod', '--env', 'staging'], 'platform deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parseAppCommandArgs(['--preview', '--preview'], 'platform deploy'),
      'INVALID_USAGE',
      2,
    );

    expect(parseServiceCreateArgs(['keyvalue', '--name', 'kv', '--env', 'staging'])).toMatchObject({
      type: 'keyvalue',
      name: 'kv',
      env: 'staging',
    });
    expectFailure(
      () => parseServiceCreateArgs(['keyvalue', '--name', 'kv', '--env', 'bad']),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () =>
        parseServiceCreateArgs(['keyvalue', '--name', 'kv', '--env', 'prod', '--env', 'staging']),
      'INVALID_USAGE',
      2,
    );

    expect(
      parseServiceNameArgs(['kv', '--env', 'staging'], 'platform service delete'),
    ).toMatchObject({
      name: 'kv',
      env: 'staging',
    });
    expectFailure(
      () => parseServiceNameArgs(['kv', '--env', 'bad'], 'platform service delete'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () =>
        parseServiceNameArgs(
          ['kv', '--env', 'prod', '--env', 'staging'],
          'platform service delete',
        ),
      'INVALID_USAGE',
      2,
    );

    for (const badLogin of [
      ['--target', 'a', '--target', 'b'],
      ['--controller', 'a', '--controller', 'b'],
      ['--account', 'a', '--account', 'b'],
      ['--api-key', 'a', '--api-key', 'b'],
      ['--ca-file', 'a', '--ca-file', 'b'],
      ['--ca-file', 'a', '--no-ca'],
      ['--unknown'],
      ['extra'],
    ]) {
      expectFailure(() => parseLoginArgs(badLogin), 'INVALID_USAGE', 2);
    }

    for (const badAccount of [
      ['--target', 'a', '--target', 'b'],
      ['--account', 'a', '--account', 'b'],
      ['--unknown'],
      ['extra'],
    ]) {
      expectFailure(
        () => parseAccountCommandArgs(badAccount, 'platform whoami'),
        'INVALID_USAGE',
        2,
      );
    }

    for (const badLogs of [
      ['--service', 'a', '--service', 'b'],
      ['--target', 'a', '--target', 'b'],
      ['--account', 'a', '--account', 'b'],
      ['--env', 'bad'],
      ['--env', 'prod', '--env', 'staging'],
      ['--deployment', 'a', '--deployment', 'b'],
      ['--since', '1m', '--since', '2m'],
      ['--tail', '1', '--tail', '2'],
      ['--tail', '-1'],
      ['--unknown'],
      ['svc1', 'svc2'],
    ]) {
      expectFailure(() => parseLogsArgs(badLogs), 'INVALID_USAGE', 2);
    }

    for (const badConfig of [
      [],
      ['invalid'],
      ['list', 'unexpected'],
      ['set'],
      ['set', 'k'],
      ['set', 'k', '--from-file', 'a', '--value', 'b'],
      ['set', 'k', '--value', 'a', 'extra'],
      ['set', 'k', '--value', 'a', '--target', 't1', '--target', 't2'],
      ['set', 'k', '--value', 'a', '--account', 'a1', '--account', 'a2'],
      ['set', 'k', '--value', 'a', '--env', 'bad'],
      ['set', 'k', '--value', 'a', '--env', 'prod', '--env', 'staging'],
      ['set', 'k', '--from-file', 'a', '--from-file', 'b'],
      ['set', 'k', '--value', 'a', '--value', 'b'],
      ['set', 'k', '--value', 'a', '--unknown'],
    ]) {
      expectFailure(() => parseConfigArgs(badConfig, 'platform secrets'), 'INVALID_USAGE', 2);
    }

    expect(tlsTrustCode({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })).toBe('SELF_SIGNED_CERT_IN_CHAIN');
    expect(tlsTrustCode({ code: 'OTHER' })).toBeUndefined();

    expectFailure(() => wrapControllerError(new CommandFailure('CUSTOM', 'msg', 2)), 'CUSTOM', 2);
    expectFailure(
      () => wrapControllerError(new CliError('not logged in')),
      'WASMCLOUD_CONTROLLER_AUTH_REQUIRED',
      2,
    );
    expectFailure(
      () => wrapControllerError(new OidcError('bad oidc', 400)),
      'WASMCLOUD_OIDC_FAILED',
      3,
    );
    expectFailure(
      () =>
        wrapControllerError(
          Object.assign(new Error('self signed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
        ),
      'WASMCLOUD_TLS_UNTRUSTED',
      3,
    );
    expectFailure(
      () =>
        wrapControllerError(
          new ControllerError(409, { title: 'Conflict', detail: 'already exists' }),
        ),
      'WASMCLOUD_CONTROLLER_ERROR',
      2,
    );
    expectFailure(
      () => wrapControllerError(new ControllerError(503, {})),
      'WASMCLOUD_CONTROLLER_ERROR',
      3,
    );
    expect(() => wrapControllerError(new Error('unexpected'))).toThrow('unexpected');

    // Missing controller/target on login in an empty directory
    const emptyDir = mkdtempSync(join(tmpdir(), 'platform-empty-'));
    const { io } = captureIo();
    await expect(
      runWasmcloudLogin([], io, makeControllerDeps({ cwd: emptyDir })),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });

    // Missing service on logs in an empty directory
    await expect(
      runWasmcloudLogs([], io, makeControllerDeps({ cwd: emptyDir })),
    ).rejects.toMatchObject({ code: 'INVALID_USAGE' });

    // Passing a managed target to login fails with WASMCLOUD_TARGET_INVALID_KIND
    const { root } = makeWorkspace();
    await expect(
      runWasmcloudLogin(['--target', 'local'], io, makeControllerDeps({ cwd: root })),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TARGET_INVALID_KIND' });
  });
});
