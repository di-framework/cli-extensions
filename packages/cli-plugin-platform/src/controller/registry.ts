import { CliError } from './credentials';

/** A registry origin the CLI may send a credential to, checked by `registryOrigin`. */
export interface RegistryOrigin {
  /** `scheme://host[:port]`, no path, userinfo, query, or fragment. */
  origin: string;
  /** `host[:port]`, the login server name the tools take. */
  host: string;
  /** True for an `http:` origin, which is only accepted for loopback and in-cluster hosts. */
  plainHttp: boolean;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(String.raw`^${LABEL}(?:\.${LABEL})*$`);
const IPV6 = /^\[[0-9a-f:.]+\]$/;

function isClusterLocal(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return hostname.endsWith('.svc') || hostname.endsWith('.svc.cluster.local');
}

/**
 * Checks the registry URL the controller returned before any credential is sent to it.
 */
export function registryOrigin(value: string): RegistryOrigin {
  const refuse = (why: string): never => {
    throw new CliError(`the controller returned an unusable registry URL: ${why}`);
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse('not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') refuse('the scheme must be https');
  if (url.username || url.password) refuse('userinfo is not allowed');
  if (url.pathname !== '/' || url.search || url.hash)
    refuse('path, query, and fragment are not allowed');
  const hostname = url.hostname.toLowerCase();
  if (!HOSTNAME.test(hostname) && !IPV6.test(hostname)) refuse('the host is not a valid hostname');
  const plainHttp = url.protocol === 'http:';
  if (plainHttp && !isClusterLocal(hostname)) {
    refuse('plain http is only allowed for loopback and in-cluster hosts');
  }
  return { origin: url.origin, host: url.host, plainHttp };
}

/** The Basic username the registry ignores; anything else could break `user:password`. */
export function registryUsername(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value.startsWith('-')) {
    throw new CliError('the controller returned an unusable registry username');
  }
  return value;
}
