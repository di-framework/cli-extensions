import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findDeployManifest,
  interpolateEnv,
  isControllerDomain,
  isTenantName,
  loadDeployManifest,
  normalizeControllerUrl,
  parseDeployManifest,
} from '../src/manifest';
import { expectFailure, makeWorkspace } from './helpers';

describe('deploy manifest discovery', () => {
  it('walks upward from nested directories to di-framework.deploy.toml', () => {
    const { root, greeter, echo } = makeWorkspace();
    expect(findDeployManifest(join(greeter, 'src'))).toBe(join(root, 'di-framework.deploy.toml'));
    expect(findDeployManifest(echo)).toBe(join(root, 'di-framework.deploy.toml'));
    expect(findDeployManifest(root)).toBe(join(root, 'di-framework.deploy.toml'));
  });

  it('fails when no manifest exists above the start directory', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wasmcloud-nommanifest-'));
    expectFailure(() => loadDeployManifest(empty, {}), 'WASMCLOUD_DEPLOY_MANIFEST_NOT_FOUND', 2);
  });
});

describe('parseDeployManifest', () => {
  it('parses managed and external targets and default-target', () => {
    const path = '/workspace/di-framework.deploy.toml';
    const manifest = parseDeployManifest(
      path,
      `default-target = "local"

[targets.local]
platform = "deploy/platform"
stack = "dev"

[targets.development]
kubeconfig = "/tmp/kubeconfig"
context = "team-development"
namespace = "wasmcloud"
registry = "registry.example.com/team"
`,
      {},
    );
    expect(manifest.workspaceRoot).toBe('/workspace');
    expect(manifest.defaultTarget).toBe('local');
    expect(manifest.targets.local).toEqual({
      kind: 'managed',
      name: 'local',
      platform: 'deploy/platform',
      stack: 'dev',
    });
    expect(manifest.targets.development).toMatchObject({
      kind: 'external',
      name: 'development',
      kubeconfig: '/tmp/kubeconfig',
      context: 'team-development',
    });
  });

  it('defaults stack to dev and discovery patterns', () => {
    const manifest = parseDeployManifest(
      '/workspace/di-framework.deploy.toml',
      `[targets.local]\nplatform = "deploy/platform"\n`,
      {},
    );
    expect(manifest.targets.local).toMatchObject({ stack: 'dev' });
    expect(manifest.discovery.include).toEqual(['**']);
    expect(manifest.discovery.exclude).toContain('dist/**');
  });

  it('interpolates environment variables and fails when they are unset', () => {
    const source = `[targets.development]
kubeconfig = "\${KUBECONFIG}"
namespace = "wasmcloud"
registry = "registry.example.com/\${TEAM}"
`;
    const manifest = parseDeployManifest('/workspace/di-framework.deploy.toml', source, {
      KUBECONFIG: '/home/me/.kube/config',
      TEAM: 'platform',
    });
    expect(manifest.targets.development).toMatchObject({
      kubeconfig: '/home/me/.kube/config',
      registry: 'registry.example.com/platform',
    });

    expectFailure(
      () => parseDeployManifest('/workspace/di-framework.deploy.toml', source, { TEAM: 'x' }),
      'WASMCLOUD_ENV_UNSET',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest('/workspace/di-framework.deploy.toml', source, {
          KUBECONFIG: '',
          TEAM: 'x',
        }),
      'WASMCLOUD_ENV_UNSET',
      2,
    );
  });

  it('accepts separate registry push and pull locations with explicit transport', () => {
    const manifest = parseDeployManifest(
      '/workspace/di-framework.deploy.toml',
      `[targets.local]
kubeconfig = "/tmp/kubeconfig"
namespace = "wasmcloud"

[targets.local.registry]
push = "http://127.0.0.1:25000"
pull = "registry.wasmcloud.svc.cluster.local:5000"
insecure = true
`,
      {},
    );
    expect(manifest.targets.local).toMatchObject({
      registry: {
        push: 'http://127.0.0.1:25000',
        pull: 'registry.wasmcloud.svc.cluster.local:5000',
        insecure: true,
      },
    });
  });

  it('rejects malformed structured registry fields', () => {
    const path = '/workspace/di-framework.deploy.toml';
    for (const registry of [
      'registry = true',
      `[targets.local.registry]\npush = "localhost:5000"\npull = "registry:5000"\nextra = "nope"`,
      `[targets.local.registry]\npush = "localhost:5000"\npull = "registry:5000"\ninsecure = "yes"`,
    ]) {
      expectFailure(
        () =>
          parseDeployManifest(
            path,
            `[targets.local]\nkubeconfig = "/tmp/kubeconfig"\nnamespace = "wasmcloud"\n${registry}\n`,
            {},
          ),
        'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
        2,
      );
    }
  });

  it('rejects apps classifiers, mixed targets, and incomplete external targets', () => {
    const path = '/workspace/di-framework.deploy.toml';
    expectFailure(
      () => parseDeployManifest(path, `apps = "nope"\n[targets.local]\nplatform = "p"\n`, {}),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `[targets.mixed]\nplatform = "deploy/platform"\nkubeconfig = "/tmp/kube"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `[targets.development]\nkubeconfig = "/tmp/kube"\nnamespace = "wasmcloud"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () => parseDeployManifest(path, `[targets.empty]\n`, {}),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `[targets.bad]
kubeconfig = "/tmp/kube"
namespace = "wasmcloud"
[targets.bad.registry]
push = "localhost:5000"
insecure = true
`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `default-target = "missing"\n[targets.local]\nplatform = "deploy/platform"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
  });

  it('derives namespace and hostgroup from a tenant; explicit values win', () => {
    const path = '/workspace/di-framework.deploy.toml';
    const manifest = parseDeployManifest(
      path,
      `default-target = "dev"

[targets.dev]
kubeconfig = "/tmp/dev.kubeconfig"
tenant = "meshtastic"
registry = "registry.example.com/meshtastic"

[targets.ci]
kubeconfig = "/tmp/ci.kubeconfig"
tenant = "meshtastic"
namespace = "di-tenant-meshtastic-ci"
hostgroup = "tenant-meshtastic-ci"
registry = "registry.example.com/ci"
`,
      {},
    );
    expect(manifest.targets.dev).toEqual({
      kind: 'external',
      name: 'dev',
      kubeconfig: '/tmp/dev.kubeconfig',
      tenant: 'meshtastic',
      namespace: 'di-tenant-meshtastic',
      hostgroup: 'tenant-meshtastic',
      registry: 'registry.example.com/meshtastic',
      context: undefined,
    });
    expect(manifest.targets.ci).toMatchObject({
      tenant: 'meshtastic',
      namespace: 'di-tenant-meshtastic-ci',
      hostgroup: 'tenant-meshtastic-ci',
    });
  });

  it('validates tenant names like the platform and explains a missing tenant or namespace', () => {
    const path = '/workspace/di-framework.deploy.toml';
    const target = (fields: string) =>
      `[targets.dev]\nkubeconfig = "/tmp/kube"\nregistry = "r.example.com/x"\n${fields}`;
    expect(isTenantName('a'.repeat(40))).toBe(true);
    for (const tenant of [
      '',
      'Mesh',
      '1mesh',
      'mesh-',
      'mesh--tastic',
      'mesh_tastic',
      'a'.repeat(41),
    ]) {
      expect(isTenantName(tenant)).toBe(false);
      if (tenant === '') continue;
      expect(() => parseDeployManifest(path, target(`tenant = "${tenant}"\n`), {})).toThrow(
        'targets.dev.tenant must be a platform tenant name',
      );
    }
    expect(() => parseDeployManifest(path, target(''), {})).toThrow(
      'external targets require kubeconfig, registry, and either tenant',
    );
    expect(() => parseDeployManifest(path, target(''), {})).toThrow(
      'Missing: tenant or namespace.',
    );
    expect(() => parseDeployManifest(path, `[targets.dev]\ntenant = "meshtastic"\n`, {})).toThrow(
      'Missing: kubeconfig, registry.',
    );
    expect(() =>
      parseDeployManifest(
        path,
        `[targets.dev]\nplatform = "deploy/platform"\ntenant = "meshtastic"\n`,
        {},
      ),
    ).toThrow('mixes managed-platform and kubeconfig fields (platform, tenant)');
  });

  it('rejects malformed TOML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wasmcloud-badtoml-'));
    const path = join(dir, 'di-framework.deploy.toml');
    writeFileSync(path, 'default-target = [\n');
    expectFailure(() => loadDeployManifest(dir, {}), 'WASMCLOUD_DEPLOY_MANIFEST_INVALID', 2);
  });

  it('rejects missing targets, empty target tables, and unknown fields', () => {
    const path = '/workspace/di-framework.deploy.toml';
    expectFailure(() => parseDeployManifest(path, '', {}), 'WASMCLOUD_DEPLOY_MANIFEST_INVALID', 2);
    expectFailure(
      () => parseDeployManifest(path, '[targets]\n', {}),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () => parseDeployManifest(path, `targets = "nope"\n`, {}),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `extra = "nope"\n[targets.local]\nplatform = "deploy/platform"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () => parseDeployManifest(path, `[targets.local]\nplatform = ""\n`, {}),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () => parseDeployManifest(path, `[targets.local]\nstack = "dev"\n`, {}),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `[targets.local]\nplatform = "deploy/platform"\nnotes = "nope"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () => parseDeployManifest(path, `[targets]\nlocal = "nope"\n`, {}),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
  });

  it('rejects invalid discovery configuration', () => {
    const path = '/workspace/di-framework.deploy.toml';
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `discovery = "nope"\n[targets.local]\nplatform = "deploy/platform"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `[discovery]\nrecursive = "yes"\n[targets.local]\nplatform = "deploy/platform"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `[discovery]\ninclude = []\n[targets.local]\nplatform = "deploy/platform"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
    expectFailure(
      () =>
        parseDeployManifest(
          path,
          `[discovery]\ninclude = "services/**"\n[targets.local]\nplatform = "deploy/platform"\n`,
          {},
        ),
      'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
      2,
    );
  });

  it('interpolates nested arrays and leaves non-string values unchanged', () => {
    expect(interpolateEnv([`pre-\${TEAM}-post`, 3], { TEAM: 'ops' }, '/m')).toEqual([
      'pre-ops-post',
      3,
    ]);
    expect(interpolateEnv(12, {}, '/m')).toBe(12);
    expect(interpolateEnv(null, {}, '/m')).toBeNull();
  });

  it('parses and validates env, bindings, and secrets in deploy manifests', () => {
    const path = '/workspace/di-framework.deploy.toml';
    const manifest = parseDeployManifest(
      path,
      `env = "prod"
secrets = ["s1", "s2", "s1"]

[bindings.cache]
capability = "keyvalue"
service = "redis"

[bindings.cache.config]
bucket = "main"

[targets.local]
platform = "deploy/platform"
env = "staging"
secrets = ["s3"]

[targets.local.bindings.db]
capability = "postgres"
serviceName = "orders-db"
`,
      {},
    );
    expect(manifest.env).toBe('prod');
    expect(manifest.secrets).toEqual(['s1', 's2']);
    expect(manifest.bindings).toEqual([
      {
        name: 'cache',
        capability: 'keyvalue',
        serviceName: 'redis',
        config: { bucket: 'main' },
      },
    ]);
    expect(manifest.targets.local).toMatchObject({
      env: 'staging',
      secrets: ['s3'],
      bindings: [
        {
          name: 'db',
          capability: 'postgres',
          serviceName: 'orders-db',
        },
      ],
    });

    for (const invalidToml of [
      `env = "dev"\n[targets.local]\nplatform = "p"\n`,
      `bindings = "nope"\n[targets.local]\nplatform = "p"\n`,
      `[bindings]\ncache = "nope"\n[targets.local]\nplatform = "p"\n`,
      `[bindings.cache]\ncapability = "keyvalue"\nextra = "nope"\n[targets.local]\nplatform = "p"\n`,
      `[bindings.cache]\nservice = "redis"\n[targets.local]\nplatform = "p"\n`,
      `[bindings.cache]\ncapability = "keyvalue"\nconfig = "nope"\n[targets.local]\nplatform = "p"\n`,
      `[bindings.cache]\ncapability = "keyvalue"\n[bindings.cache.config]\nflag = true\n[targets.local]\nplatform = "p"\n`,
    ]) {
      expectFailure(
        () => parseDeployManifest(path, invalidToml, {}),
        'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
        2,
      );
    }
  });

  it('parses and validates account and controller targets', () => {
    const path = '/workspace/di-framework.deploy.toml';
    expect(isControllerDomain('localhost')).toBe(true);
    expect(isControllerDomain('authproto.example.com:8443')).toBe(true);
    expect(isControllerDomain('localhost:70000')).toBe(false);
    expect(isControllerDomain('-bad.example.com')).toBe(false);
    expect(isControllerDomain('a'.repeat(261))).toBe(false);

    expect(normalizeControllerUrl('https://acme.controller.example.com/')).toBe(
      'https://acme.controller.example.com',
    );
    expect(normalizeControllerUrl('http://localhost:8080/sub/')).toBe('http://localhost:8080/sub');
    expect(normalizeControllerUrl('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(normalizeControllerUrl('http://[::1]:9000')).toBe('http://[::1]:9000');
    expect(normalizeControllerUrl('http://controller.tenant.svc')).toBe(
      'http://controller.tenant.svc',
    );
    expect(normalizeControllerUrl('http://controller.tenant.svc.cluster.local')).toBe(
      'http://controller.tenant.svc.cluster.local',
    );
    expect(normalizeControllerUrl('not-a-url')).toBeUndefined();
    expect(normalizeControllerUrl('ftp://example.com')).toBeUndefined();
    expect(normalizeControllerUrl('https://user:pass@example.com')).toBeUndefined();
    expect(normalizeControllerUrl('https://example.com?foo=1')).toBeUndefined();
    expect(normalizeControllerUrl('https://example.com#frag')).toBeUndefined();
    expect(normalizeControllerUrl('https://bad_host.example.com')).toBeUndefined();
    expect(normalizeControllerUrl('http://remote.example.com')).toBeUndefined();

    const manifest = parseDeployManifest(
      path,
      `default-target = "authproto"

[targets.authproto]
account = "acme"
domain = "authproto.internal:8443"
env = "staging"
secrets = ["db-url"]

[targets.direct]
controller = "https://acme.controller.example.com/"
account = "acme"

[targets.loopback]
controller = "http://127.0.0.1:18080"
`,
      {},
    );

    expect(manifest.targets.authproto).toEqual({
      kind: 'account',
      name: 'authproto',
      account: 'acme',
      domain: 'authproto.internal:8443',
      env: 'staging',
      secrets: ['db-url'],
    });
    expect(manifest.targets.direct).toEqual({
      kind: 'controller',
      name: 'direct',
      controller: 'https://acme.controller.example.com',
      account: 'acme',
    });
    expect(manifest.targets.loopback).toEqual({
      kind: 'controller',
      name: 'loopback',
      controller: 'http://127.0.0.1:18080',
    });

    for (const invalidTarget of [
      `[targets.bad]\naccount = "Bad_Name"\n`,
      `[targets.bad]\naccount = "acme"\ndomain = "bad_domain"\n`,
      `[targets.bad]\ncontroller = "http://remote.example.com"\n`,
      `[targets.bad]\ncontroller = "https://acme.controller.example.com"\ndomain = "example.com"\n`,
      `[targets.bad]\ndomain = "example.com"\n`,
      `[targets.bad]\naccount = "acme"\nplatform = "deploy/platform"\n`,
      `[targets.bad]\ncontroller = "https://acme.controller.example.com"\nkubeconfig = "/tmp/k"\n`,
    ]) {
      expectFailure(
        () => parseDeployManifest(path, invalidTarget, {}),
        'WASMCLOUD_DEPLOY_MANIFEST_INVALID',
        2,
      );
    }
  });
});
