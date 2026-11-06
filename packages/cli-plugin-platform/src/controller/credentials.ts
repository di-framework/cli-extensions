import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WasmcloudDeps } from '../deps';
import type { AccountTarget, ControllerTarget } from '../manifest';
import { discoverAccountControllerUrl } from '../target';
import { createClient, type TenantClient } from './client';
import { discover, OidcError, refreshTokens, type TokenResponse } from './oidc';
import { caPem, trusting } from './trust';

export interface Credential {
  account: string;
  user: string;
  role: string;
  via: 'identity' | 'api-key';
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  /** Access token expiry; absent for API keys. */
  expiresAt?: string;
  /** Where an identity login refreshes and revokes: the issuer and the public client id. */
  issuer?: string;
  clientId?: string;
  controller: { url: string; certificateAuthorityData?: string };
  registry?: { host: string; config?: string; fingerprint?: string; tool?: string };
  console?: string;
}

/** True when an identity token is gone or within a minute of expiring, so it must be refreshed. */
export function needsRefresh(credential: Credential, now = Date.now()): boolean {
  if (credential.via !== 'identity' || !credential.refreshToken) return false;
  if (!credential.accessToken) return true;
  return credential.expiresAt !== undefined && Date.parse(credential.expiresAt) - now <= 60_000;
}

export type CredentialStore = Record<string, Credential>;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const home = (env: Record<string, string | undefined> = process.env): string =>
  env.DI_FRAMEWORK_HOME ?? join(homedir(), '.di-framework');

const credentialsPath = (env?: Record<string, string | undefined>) =>
  join(home(env), 'credentials.json');

export function readStore(env?: Record<string, string | undefined>): CredentialStore {
  const path = credentialsPath(env);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as CredentialStore) : {};
}

export function writeStore(store: CredentialStore, env?: Record<string, string | undefined>): void {
  const directory = home(env);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The bearer a credential presents: the API key, or the identity access token while it lasts. */
export function bearer(credential: Credential): string {
  if (credential.apiKey) return credential.apiKey;
  if (!credential.accessToken) throw new CliError('the credential holds no token; log in again');
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
    throw new CliError('the login has expired; run login again');
  }
  return credential.accessToken;
}

/**
 * The account a command runs against: `--account`, then `DI_TENANT_ACCOUNT`, then the only
 * credential on disk.
 */
export function resolveAccount(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  store: CredentialStore,
): string {
  const named = flag ?? env.DI_TENANT_ACCOUNT;
  if (named) return named;
  const accounts = Object.keys(store);
  if (accounts.length === 1) return accounts[0] as string;
  throw new CliError(
    accounts.length === 0
      ? 'not logged in; run: di-framework platform login --controller <url> --account <tenant>'
      : `--account <tenant> is required; logged in to ${accounts.join(', ')}`,
  );
}

export function load(account: string, env?: Record<string, string | undefined>): Credential {
  const credential = readStore(env)[account];
  if (!credential) {
    throw new CliError(
      `not logged in to ${account}; run: di-framework platform login --account ${account}`,
    );
  }
  return credential;
}

export function issuedTokens(tokens: TokenResponse, previousRefresh?: string) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefresh,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}

export async function refreshCredential(
  credential: Credential,
  doFetch?: typeof fetch,
): Promise<Credential> {
  if (!credential.issuer || !credential.clientId || !credential.refreshToken) {
    throw new CliError('the login cannot be refreshed; run login again');
  }
  const metadata = await discover(credential.issuer, doFetch);
  let tokens: TokenResponse;
  try {
    tokens = await refreshTokens(
      metadata,
      { clientId: credential.clientId, refreshToken: credential.refreshToken },
      doFetch,
    );
  } catch (error) {
    if (error instanceof OidcError) {
      throw new CliError(`the login has expired (${error.message}); run login again`);
    }
    throw error;
  }
  return { ...credential, ...issuedTokens(tokens, credential.refreshToken) };
}

export type ResolveControllerSessionOptions = {
  target?: AccountTarget | ControllerTarget;
  account?: string;
  fresh?: boolean;
};

function resolveAccountTargetCredential(
  target: AccountTarget,
  account: string | undefined,
  store: CredentialStore,
  env: Record<string, string | undefined>,
): { stored: Credential; controllerUrlOverride: string } {
  const resolvedAccount = account ?? target.account;
  const entry = store[resolvedAccount];
  if (!entry) {
    throw new CliError(
      `not logged in to ${resolvedAccount}; run: di-framework platform login --target ${target.name}`,
    );
  }
  const controllerUrlOverride = target.domain
    ? discoverAccountControllerUrl(resolvedAccount, target.domain, env)
    : entry.controller.url || discoverAccountControllerUrl(resolvedAccount, undefined, env);
  return { stored: entry, controllerUrlOverride };
}

export function resolveControllerTargetCredential(
  target: ControllerTarget,
  account: string | undefined,
  store: CredentialStore,
): Credential {
  const controllerUrl = target.controller.replace(/\/$/, '');
  const accountHint = account ?? target.account;
  if (accountHint !== undefined) {
    const stored = store[accountHint];
    if (!stored) {
      throw new CliError(
        `not logged in to ${accountHint}; run: di-framework platform login --target ${target.name}`,
      );
    }
    if (stored.controller.url.replace(/\/$/, '') !== controllerUrl) {
      throw new CliError(
        `credential for ${accountHint} is for ${stored.controller.url}, not ${controllerUrl}; run: di-framework platform login --target ${target.name}`,
      );
    }
    return stored;
  }
  const matched = Object.values(store).find(
    (entry) => entry.controller.url.replace(/\/$/, '') === controllerUrl,
  );
  if (!matched) {
    throw new CliError(
      `not logged in to ${controllerUrl}; run: di-framework platform login --target ${target.name}`,
    );
  }
  return matched;
}

export async function resolveControllerSession(
  options: ResolveControllerSessionOptions,
  deps: Pick<WasmcloudDeps, 'env' | 'fetch'>,
): Promise<{ credential: Credential; client: TenantClient }> {
  const store = readStore(deps.env);
  let stored: Credential;
  let controllerUrlOverride: string | undefined;

  if (options.target?.kind === 'account') {
    const resolved = resolveAccountTargetCredential(
      options.target,
      options.account,
      store,
      deps.env,
    );
    stored = resolved.stored;
    controllerUrlOverride = resolved.controllerUrlOverride;
  } else if (options.target?.kind === 'controller') {
    stored = resolveControllerTargetCredential(options.target, options.account, store);
  } else {
    const account = resolveAccount(options.account, deps.env, store);
    stored = load(account, deps.env);
  }

  const refreshable = stored.via === 'identity' && stored.refreshToken !== undefined;
  if (needsRefresh(stored) || (options.fresh && refreshable)) {
    stored = await refreshCredential(stored, trusting(deps.fetch, caPem(stored.controller)));
    store[stored.account] = stored;
    writeStore(store, deps.env);
  }

  const credential: Credential =
    controllerUrlOverride === undefined
      ? stored
      : { ...stored, controller: { ...stored.controller, url: controllerUrlOverride } };

  const client = createClient({
    baseUrl: credential.controller.url,
    token: bearer(credential),
    fetch: trusting(deps.fetch, caPem(credential.controller)),
  });
  return { credential, client };
}
