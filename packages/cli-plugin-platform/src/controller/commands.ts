import { readFileSync } from 'node:fs';
import {
  type CliIo,
  CommandFailure,
  type CommandResult,
  type JsonValue,
} from '@di-framework/cli-extension';
import { DEFAULT_DEPS, type WasmcloudDeps } from '../deps';
import {
  type AccountTarget,
  type ControllerTarget,
  type DeployEnvironment,
  type DeployManifest,
  findDeployManifest,
  loadDeployManifest,
} from '../manifest';
import { loadProject } from '../project';
import { invalidUsage, matchOption } from '../support';
import { discoverAccountControllerUrl, isControllerBackedTarget, resolveTarget } from '../target';
import { deploymentResourceName } from '../workload';
import { type ControllerError, createClient, type LogEvent } from './client';
import {
  bearer,
  CliError,
  type Credential,
  type CredentialStore,
  issuedTokens,
  load,
  readStore,
  resolveAccount,
  resolveControllerSession,
  writeStore,
} from './credentials';
import {
  authorizationUrl,
  discover,
  exchangeCode,
  OidcError,
  pkce,
  randomToken,
  revokeToken,
  type TokenResponse,
} from './oidc';
import { caPem, readCaFile, trusting } from './trust';

const SCOPE = 'openid profile email offline_access';

const TLS_TRUST_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
]);

export function tlsTrustCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && TLS_TRUST_CODES.has(code) ? code : undefined;
}

export function wrapControllerError(error: unknown): never {
  if (error instanceof CommandFailure) throw error;
  if (error instanceof CliError) {
    throw new CommandFailure('WASMCLOUD_CONTROLLER_AUTH_REQUIRED', error.message, 2);
  }
  if (error instanceof OidcError) {
    const details = error.status === undefined ? {} : { status: error.status };
    throw new CommandFailure('WASMCLOUD_OIDC_FAILED', `identity: ${error.message}`, 3, details);
  }
  const tlsCode = tlsTrustCode(error);
  if (tlsCode) {
    const msg = `tls: ${(error as Error).message} (${tlsCode}). Trust the tenant's controller CA (ConfigMap tenant-controller-ca): login --ca-file <ca.crt>, or NODE_EXTRA_CA_CERTS=<ca.crt>.`;
    throw new CommandFailure('WASMCLOUD_TLS_UNTRUSTED', msg, 3, { code: tlsCode });
  }
  if ((error as ControllerError | undefined)?.name === 'ControllerError') {
    const failure = error as ControllerError;
    const exitCode = failure.status >= 500 ? 3 : 2;
    const details = {
      status: failure.status,
      ...(failure.problem.title ? { title: failure.problem.title } : {}),
    };
    throw new CommandFailure(
      'WASMCLOUD_CONTROLLER_ERROR',
      `controller: ${failure.status} ${failure.message}`,
      exitCode,
      details,
    );
  }
  throw error;
}

function resolveOptionalControllerTarget(
  targetName: string | undefined,
  deps: WasmcloudDeps,
  command: string,
): { manifest?: DeployManifest; target?: AccountTarget | ControllerTarget } {
  if (targetName !== undefined) {
    const manifest = loadDeployManifest(deps.cwd(), deps.env);
    const target = resolveTarget(manifest, targetName);
    if (!isControllerBackedTarget(target)) {
      const msg = `Target "${target.name}" is a ${target.kind} target; ${command} requires an account or controller target.`;
      throw new CommandFailure('WASMCLOUD_TARGET_INVALID_KIND', msg, 2, {
        target: target.name,
        kind: target.kind,
        command,
      });
    }
    return { manifest, target };
  }
  const manifestPath = findDeployManifest(deps.cwd());
  if (manifestPath === undefined) return {};
  const manifest = loadDeployManifest(deps.cwd(), deps.env);
  if (manifest.defaultTarget !== undefined) {
    const candidate = manifest.targets[manifest.defaultTarget];
    if (candidate && isControllerBackedTarget(candidate)) return { manifest, target: candidate };
  }
  return { manifest };
}

const page = (text: string, status = 200) =>
  new Response(
    `<!doctype html><title>di-framework</title><p style="font:16px system-ui;padding:24px">${text}</p>`,
    { status, headers: { 'content-type': 'text/html' } },
  );

async function browserLogin(
  info: { account: string; issuer: string; clientId: string },
  noBrowser: boolean,
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<TokenResponse> {
  const metadata = await discover(info.issuer, deps.fetch);
  const { verifier, challenge } = await pkce();
  const state = randomToken(16);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') return page('Not found.', 404);
      const refused = url.searchParams.get('error');
      if (refused) {
        reject(new CliError(`the identity server refused the login: ${refused}`));
        return page('Login failed. Return to the terminal.', 400);
      }
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.get('state') !== state) {
        reject(new CliError('the browser returned an unexpected login response'));
        return page('Login failed. Return to the terminal.', 400);
      }
      resolve(code);
      return page('Signed in. You can close this window and return to the terminal.');
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  try {
    const url = authorizationUrl(metadata, {
      clientId: info.clientId,
      redirectUri,
      scope: SCOPE,
      state,
      nonce: randomToken(16),
      codeChallenge: challenge,
    });
    io.stderr.write(
      `Opening your browser to sign in to ${info.account} at ${info.issuer}.\nIf it does not open, visit:\n  ${url}\n`,
    );
    if (!noBrowser) deps.openBrowser?.(url);
    const timer = setTimeout(
      () => reject(new CliError('timed out waiting for the browser login')),
      deps.loginTimeoutMs ?? 300_000,
    );
    const code = await promise.finally(() => clearTimeout(timer));
    return await exchangeCode(
      metadata,
      { clientId: info.clientId, redirectUri, code, codeVerifier: verifier },
      deps.fetch,
    );
  } finally {
    await server.stop();
  }
}

function storedCa(store: CredentialStore, controller: string, drop: boolean): string | undefined {
  if (drop) return undefined;
  return Object.values(store).find((c) => c.controller.url === controller)?.controller
    .certificateAuthorityData;
}

export type LoginOptions = {
  target?: string;
  controller?: string;
  account?: string;
  apiKey?: string;
  caFile?: string;
  noCa: boolean;
  noBrowser: boolean;
};

export function parseLoginArgs(args: readonly string[]): LoginOptions {
  let target: string | undefined;
  let controller: string | undefined;
  let account: string | undefined;
  let apiKey: string | undefined;
  let caFile: string | undefined;
  let noCa = false;
  let noBrowser = false;

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    const targetOpt = matchOption(args, position, token, '--target');
    if (targetOpt) {
      if (target !== undefined)
        invalidUsage('Option may be provided only once: --target', '--target');
      target = targetOpt.value;
      position = targetOpt.consumedThrough;
      continue;
    }
    const controllerOpt = matchOption(args, position, token, '--controller');
    if (controllerOpt) {
      if (controller !== undefined)
        invalidUsage('Option may be provided only once: --controller', '--controller');
      controller = controllerOpt.value;
      position = controllerOpt.consumedThrough;
      continue;
    }
    const accountOpt = matchOption(args, position, token, '--account');
    if (accountOpt) {
      if (account !== undefined)
        invalidUsage('Option may be provided only once: --account', '--account');
      account = accountOpt.value;
      position = accountOpt.consumedThrough;
      continue;
    }
    const apiKeyOpt = matchOption(args, position, token, '--api-key');
    if (apiKeyOpt) {
      if (apiKey !== undefined)
        invalidUsage('Option may be provided only once: --api-key', '--api-key');
      apiKey = apiKeyOpt.value;
      position = apiKeyOpt.consumedThrough;
      continue;
    }
    const caFileOpt = matchOption(args, position, token, '--ca-file');
    if (caFileOpt) {
      if (caFile !== undefined)
        invalidUsage('Option may be provided only once: --ca-file', '--ca-file');
      caFile = caFileOpt.value;
      position = caFileOpt.consumedThrough;
      continue;
    }
    if (token === '--no-ca') {
      noCa = true;
      continue;
    }
    if (token === '--no-browser') {
      noBrowser = true;
      continue;
    }
    invalidUsage(
      token.startsWith('--') ? `Unknown option: ${token}` : `Unexpected argument: ${token}`,
      token,
      { command: 'platform login' },
    );
  }

  if (caFile !== undefined && noCa) {
    invalidUsage('--ca-file and --no-ca are exclusive', '--no-ca', { command: 'platform login' });
  }

  return {
    ...(target ? { target } : {}),
    ...(controller ? { controller } : {}),
    ...(account ? { account } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(caFile ? { caFile } : {}),
    noCa,
    noBrowser,
  };
}

export async function runWasmcloudLogin(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseLoginArgs(args);
  try {
    const store = readStore(deps.env);
    const { target } = resolveOptionalControllerTarget(options.target, deps, 'platform login');

    let account = options.account;
    let rawController = options.controller;
    if (target?.kind === 'account') {
      account = account ?? target.account;
      const defaultUrl =
        store[account]?.controller.url ??
        discoverAccountControllerUrl(account, undefined, deps.env);
      const targetUrl = target.domain
        ? discoverAccountControllerUrl(account, target.domain, deps.env)
        : defaultUrl;
      rawController = rawController ?? targetUrl;
    } else if (target?.kind === 'controller') {
      account = account ?? target.account;
      rawController = rawController ?? target.controller;
    } else if (rawController === undefined && account !== undefined) {
      rawController =
        store[account]?.controller.url ??
        discoverAccountControllerUrl(account, undefined, deps.env);
    }

    if (rawController === undefined) {
      invalidUsage(
        'Missing required --controller <url> or --target <name> for platform login',
        '--controller',
        { command: 'platform login' },
      );
    }

    const controller = rawController.replace(/\/$/, '');
    const certificateAuthorityData = options.caFile
      ? readCaFile(options.caFile)
      : storedCa(store, controller, options.noCa);
    const controllerInfo = { url: controller, certificateAuthorityData };
    const controllerFetch = trusting(deps.fetch, caPem(controllerInfo));
    const info = await createClient({ baseUrl: controller, fetch: controllerFetch }).authInfo();
    if (account !== undefined && info.account !== account) {
      throw new CliError(`${controller} serves account ${info.account}, not ${account}`);
    }
    const tokens = options.apiKey
      ? undefined
      : await browserLogin(info, options.noBrowser, io, deps);
    const token = options.apiKey ?? (tokens as TokenResponse).access_token;
    const who = await createClient({
      baseUrl: controller,
      token,
      fetch: controllerFetch,
    }).whoami();
    const base = {
      account: info.account,
      user: who.user,
      role: who.role,
      controller: certificateAuthorityData ? controllerInfo : { url: controller },
    };
    const credential: Credential = options.apiKey
      ? { ...base, via: 'api-key', apiKey: options.apiKey }
      : {
          ...base,
          via: 'identity',
          issuer: info.issuer,
          clientId: info.clientId,
          ...issuedTokens(tokens as TokenResponse),
        };
    store[info.account] = credential;
    writeStore(store, deps.env);
    const text = `Logged in to ${info.account} as ${who.user} (${who.role}) via ${credential.via}.`;
    io.stderr.write(`${text}\n`);
    return {
      data: {
        account: info.account,
        user: who.user,
        role: who.role,
        via: credential.via,
        controller,
      },
      text,
    };
  } catch (error) {
    wrapControllerError(error);
  }
}

export type AccountCommandOptions = {
  target?: string;
  account?: string;
};

export function parseAccountCommandArgs(
  args: readonly string[],
  command: string,
): AccountCommandOptions {
  let target: string | undefined;
  let account: string | undefined;

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    const targetOpt = matchOption(args, position, token, '--target');
    if (targetOpt) {
      if (target !== undefined)
        invalidUsage('Option may be provided only once: --target', '--target');
      target = targetOpt.value;
      position = targetOpt.consumedThrough;
      continue;
    }
    const accountOpt = matchOption(args, position, token, '--account');
    if (accountOpt) {
      if (account !== undefined)
        invalidUsage('Option may be provided only once: --account', '--account');
      account = accountOpt.value;
      position = accountOpt.consumedThrough;
      continue;
    }
    invalidUsage(
      token.startsWith('--') ? `Unknown option: ${token}` : `Unexpected argument: ${token}`,
      token,
      { command },
    );
  }

  return {
    ...(target ? { target } : {}),
    ...(account ? { account } : {}),
  };
}

export async function runWasmcloudLogout(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseAccountCommandArgs(args, 'platform logout');
  try {
    const store = readStore(deps.env);
    const { target } = resolveOptionalControllerTarget(options.target, deps, 'platform logout');
    let account: string;
    if (options.account !== undefined) {
      account = options.account;
    } else if (target?.kind === 'account') {
      account = target.account;
    } else if (target?.kind === 'controller') {
      if (target.account !== undefined) {
        account = target.account;
      } else {
        const matched = Object.values(store).find(
          (entry) =>
            entry.controller.url.replace(/\/$/, '') === target.controller.replace(/\/$/, ''),
        );
        account = matched ? matched.account : resolveAccount(undefined, deps.env, store);
      }
    } else {
      account = resolveAccount(undefined, deps.env, store);
    }

    const credential = load(account, deps.env);
    try {
      await createClient({
        baseUrl: credential.controller.url,
        token: bearer(credential),
        fetch: trusting(deps.fetch, caPem(credential.controller)),
      }).logout();
    } catch {
      // An expired or already revoked token; nothing to tell the controller.
    }
    if (credential.via === 'identity' && credential.refreshToken && credential.issuer) {
      try {
        const trustedFetch = trusting(deps.fetch, caPem(credential.controller));
        await revokeToken(
          await discover(credential.issuer, trustedFetch),
          credential.clientId ?? '',
          credential.refreshToken,
          trustedFetch,
          credential.issuer,
        );
      } catch (error) {
        io.stderr.write(
          `warning: failed to revoke token at ${credential.issuer}: ${(error as Error).message}\n`,
        );
      }
    }
    delete store[account];
    writeStore(store, deps.env);
    const text = `Logged out of ${account}.`;
    io.stderr.write(`${text}\n`);
    return {
      data: { account, loggedOut: true },
      text,
    };
  } catch (error) {
    wrapControllerError(error);
  }
}

export async function runWasmcloudWhoami(
  args: readonly string[],
  _io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseAccountCommandArgs(args, 'platform whoami');
  try {
    const { target } = resolveOptionalControllerTarget(options.target, deps, 'platform whoami');
    const { credential, client } = await resolveControllerSession(
      { target, account: options.account },
      deps,
    );
    const who = await client.whoami();
    return {
      data: {
        ...who,
        controller: credential.controller.url,
      },
      text: `${who.user} (${who.role}) in ${who.account} via ${who.via}`,
    };
  } catch (error) {
    wrapControllerError(error);
  }
}

export type LogsCommandOptions = {
  service?: string;
  target?: string;
  account?: string;
  env?: DeployEnvironment;
  deployment?: string;
  follow: boolean;
  since?: string;
  tail?: number;
};

export function parseLogsArgs(args: readonly string[]): LogsCommandOptions {
  let service: string | undefined;
  let target: string | undefined;
  let account: string | undefined;
  let env: DeployEnvironment | undefined;
  let deployment: string | undefined;
  let follow = false;
  let since: string | undefined;
  let tail: number | undefined;

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    const serviceOpt = matchOption(args, position, token, '--service');
    if (serviceOpt) {
      if (service !== undefined)
        invalidUsage('Option may be provided only once: --service', '--service');
      service = serviceOpt.value;
      position = serviceOpt.consumedThrough;
      continue;
    }
    const targetOpt = matchOption(args, position, token, '--target');
    if (targetOpt) {
      if (target !== undefined)
        invalidUsage('Option may be provided only once: --target', '--target');
      target = targetOpt.value;
      position = targetOpt.consumedThrough;
      continue;
    }
    const accountOpt = matchOption(args, position, token, '--account');
    if (accountOpt) {
      if (account !== undefined)
        invalidUsage('Option may be provided only once: --account', '--account');
      account = accountOpt.value;
      position = accountOpt.consumedThrough;
      continue;
    }
    const envOpt = matchOption(args, position, token, '--env');
    if (envOpt) {
      if (env !== undefined) invalidUsage('Option may be provided only once: --env', '--env');
      if (envOpt.value !== 'prod' && envOpt.value !== 'staging') {
        invalidUsage('--env must be prod or staging', envOpt.value, { command: 'platform logs' });
      }
      env = envOpt.value;
      position = envOpt.consumedThrough;
      continue;
    }
    const deploymentOpt = matchOption(args, position, token, '--deployment');
    if (deploymentOpt) {
      if (deployment !== undefined)
        invalidUsage('Option may be provided only once: --deployment', '--deployment');
      deployment = deploymentOpt.value;
      position = deploymentOpt.consumedThrough;
      continue;
    }
    const sinceOpt = matchOption(args, position, token, '--since');
    if (sinceOpt) {
      if (since !== undefined) invalidUsage('Option may be provided only once: --since', '--since');
      since = sinceOpt.value;
      position = sinceOpt.consumedThrough;
      continue;
    }
    const tailOpt = matchOption(args, position, token, '--tail');
    if (tailOpt) {
      if (tail !== undefined) invalidUsage('Option may be provided only once: --tail', '--tail');
      const parsed = Number(tailOpt.value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        invalidUsage('--tail must be a whole number', tailOpt.value, { command: 'platform logs' });
      }
      tail = parsed;
      position = tailOpt.consumedThrough;
      continue;
    }
    if (token === '--follow') {
      follow = true;
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command: 'platform logs' });
    }
    if (service !== undefined) {
      invalidUsage(`Unexpected argument: ${token}`, token, { command: 'platform logs' });
    }
    service = token;
  }

  return {
    ...(service ? { service } : {}),
    ...(target ? { target } : {}),
    ...(account ? { account } : {}),
    ...(env ? { env } : {}),
    ...(deployment ? { deployment } : {}),
    follow,
    ...(since ? { since } : {}),
    ...(tail !== undefined ? { tail } : {}),
  };
}

export async function runWasmcloudLogs(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  const options = parseLogsArgs(args);
  try {
    const { manifest, target } = resolveOptionalControllerTarget(
      options.target,
      deps,
      'platform logs',
    );
    const env = options.env ?? target?.env ?? manifest?.env ?? 'prod';
    let service = options.service;
    if (service === undefined) {
      try {
        service = deploymentResourceName(loadProject(deps.cwd()));
      } catch {
        invalidUsage('Missing required --service for platform logs', '--service', {
          command: 'platform logs',
        });
      }
    }
    const { credential, client } = await resolveControllerSession(
      { target, account: options.account },
      deps,
    );
    const events: LogEvent[] = [];
    const lines: string[] = [];
    for await (const event of client.logs(service, {
      env,
      deployment: options.deployment,
      follow: options.follow,
      since: options.since,
      tail: options.tail,
    })) {
      events.push(event);
      const line = `${event.timestamp} ${event.deployment} ${event.level ?? 'info'} ${event.message}`;
      lines.push(line);
      io.stdout.write(`${line}\n`);
    }
    return {
      data: {
        service,
        env,
        account: credential.account,
        events: events as unknown as JsonValue,
      },
      text: lines.join('\n'),
    };
  } catch (error) {
    wrapControllerError(error);
  }
}

export type ConfigAction = 'list' | 'set' | 'update' | 'unset';

export type ConfigCommandOptions = {
  action: ConfigAction;
  name?: string;
  target?: string;
  account?: string;
  env?: DeployEnvironment;
  fromFile?: string;
  value?: string;
};

export function parseConfigArgs(args: readonly string[], command: string): ConfigCommandOptions {
  let action: ConfigAction | undefined;
  let name: string | undefined;
  let target: string | undefined;
  let account: string | undefined;
  let env: DeployEnvironment | undefined;
  let fromFile: string | undefined;
  let value: string | undefined;

  for (let position = 0; position < args.length; position++) {
    const token = args[position] ?? '';
    const targetOpt = matchOption(args, position, token, '--target');
    if (targetOpt) {
      if (target !== undefined)
        invalidUsage('Option may be provided only once: --target', '--target');
      target = targetOpt.value;
      position = targetOpt.consumedThrough;
      continue;
    }
    const accountOpt = matchOption(args, position, token, '--account');
    if (accountOpt) {
      if (account !== undefined)
        invalidUsage('Option may be provided only once: --account', '--account');
      account = accountOpt.value;
      position = accountOpt.consumedThrough;
      continue;
    }
    const envOpt = matchOption(args, position, token, '--env');
    if (envOpt) {
      if (env !== undefined) invalidUsage('Option may be provided only once: --env', '--env');
      if (envOpt.value !== 'prod' && envOpt.value !== 'staging') {
        invalidUsage('--env must be prod or staging', envOpt.value, { command });
      }
      env = envOpt.value;
      position = envOpt.consumedThrough;
      continue;
    }
    const fromFileOpt = matchOption(args, position, token, '--from-file');
    if (fromFileOpt) {
      if (fromFile !== undefined)
        invalidUsage('Option may be provided only once: --from-file', '--from-file');
      fromFile = fromFileOpt.value;
      position = fromFileOpt.consumedThrough;
      continue;
    }
    const valueOpt = matchOption(args, position, token, '--value');
    if (valueOpt) {
      if (value !== undefined) invalidUsage('Option may be provided only once: --value', '--value');
      value = valueOpt.value;
      position = valueOpt.consumedThrough;
      continue;
    }
    if (token.startsWith('--')) {
      invalidUsage(`Unknown option: ${token}`, token, { command });
    }
    if (action === undefined) {
      if (token !== 'list' && token !== 'set' && token !== 'update' && token !== 'unset') {
        invalidUsage(`Usage: ${command} <list|set|update|unset> [name]`, token, { command });
      }
      action = token;
      continue;
    }
    if (name !== undefined) {
      invalidUsage(`Unexpected argument: ${token}`, token, { command });
    }
    name = token;
  }

  if (action === undefined) {
    invalidUsage(`Usage: ${command} <list|set|update|unset> [name]`, command, { command });
  }
  if (action === 'list' && name !== undefined) {
    invalidUsage(`Unexpected argument for ${command} list: ${name}`, name, { command });
  }
  if (action !== 'list' && name === undefined) {
    invalidUsage(`Missing required <name> for ${command} ${action}`, action, { command });
  }
  if (fromFile !== undefined && value !== undefined) {
    invalidUsage('--from-file and --value are exclusive', '--value', { command });
  }
  if ((action === 'set' || action === 'update') && fromFile === undefined && value === undefined) {
    invalidUsage(
      `Missing required --from-file <path|-> or --value for ${command} ${action}`,
      '--from-file',
      {
        command,
      },
    );
  }

  return {
    action,
    ...(name ? { name } : {}),
    ...(target ? { target } : {}),
    ...(account ? { account } : {}),
    ...(env ? { env } : {}),
    ...(fromFile ? { fromFile } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

function readConfigValue(options: ConfigCommandOptions, deps: WasmcloudDeps): string {
  if (options.value !== undefined) return options.value;
  const source = options.fromFile as string;
  const raw = source === '-' ? (deps.stdin?.() ?? '') : readFileSync(source, 'utf8');
  return raw.replace(/\r?\n$/, '');
}

async function runConfigCommand(
  kind: 'secrets' | 'vars',
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps,
): Promise<CommandResult> {
  const command = `platform ${kind}`;
  const options = parseConfigArgs(args, command);
  const isSecret = kind === 'secrets';
  const singular = isSecret ? 'secret' : 'var';
  try {
    const { manifest, target } = resolveOptionalControllerTarget(options.target, deps, command);
    const env = options.env ?? target?.env ?? manifest?.env ?? 'prod';
    const { credential, client } = await resolveControllerSession(
      { target, account: options.account },
      deps,
    );

    if (options.action === 'list') {
      const list = isSecret ? await client.secrets(env) : await client.vars(env);
      const formatEntry = (entry: { name: string; value?: string }) =>
        isSecret ? entry.name : `${entry.name}=${entry.value ?? ''}`;
      const text =
        list.items.length === 0 ? `no ${kind} in ${env}` : list.items.map(formatEntry).join('\n');
      return {
        data: { env, account: credential.account, items: list.items as unknown as JsonValue },
        text,
      };
    }

    const name = options.name as string;
    if (options.action === 'unset') {
      if (isSecret) {
        await client.unsetSecret(env, name);
        const text = `unset secret ${name} in ${env}`;
        io.stderr.write(`${text}\n`);
        return { data: { action: 'unset', name, env, account: credential.account }, text };
      }
      const result = await client.unsetVar(env, name);
      for (const warning of result.warnings) {
        io.stderr.write(`warning: ${warning.detail}\n`);
      }
      const text = `unset var ${name} in ${env}`;
      io.stderr.write(`${text}\n`);
      const warnings = result.warnings as unknown as JsonValue;
      return { data: { action: 'unset', name, env, account: credential.account, warnings }, text };
    }

    const value = readConfigValue(options, deps);
    if (options.action === 'set') {
      await (isSecret ? client.setSecret(env, name, value) : client.setVar(env, name, value));
    } else {
      await (isSecret ? client.updateSecret(env, name, value) : client.updateVar(env, name, value));
    }
    const text = `${options.action} ${singular} ${name} in ${env}`;
    io.stderr.write(`${text}\n`);
    return {
      data: { action: options.action, name, env, account: credential.account },
      text,
    };
  } catch (error) {
    wrapControllerError(error);
  }
}

export function runWasmcloudSecrets(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  return runConfigCommand('secrets', args, io, deps);
}

export function runWasmcloudVars(
  args: readonly string[],
  io: CliIo,
  deps: WasmcloudDeps = DEFAULT_DEPS,
): Promise<CommandResult> {
  return runConfigCommand('vars', args, io, deps);
}
