/** Operator-facing console failure. Messages are safe to return to the browser. */
export class ConsoleError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ConsoleError';
    this.status = status;
    this.code = code;
  }
}

const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const ASSIGNED_SECRET = /\b(token|password|secret|kubeconfig|authorization)\b\s*[:=]\s*\S+/gi;
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{40,}/g;
const INFRASTRUCTURE =
  /\b(pods?|namespaces?|cronjobs?|replicasets?|deployments?|replicas?|hostselectors?|hostgroups?|hostpath|nodes?|containers?|kubernetes|apiversions?|configmaps?|serviceaccounts?|secrets?|events?|kind|kubeconfigs?)\b|di-runtime|di-tenant|cluster\.local/i;

/** Remove credential-shaped substrings before text is shown or logged. */
export function sanitizePublicText(value: string, max = 400): string {
  const text = value
    .replace(BEARER, '[redacted]')
    .replace(ASSIGNED_SECRET, '[redacted]')
    .replace(LONG_TOKEN, '[redacted]');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A status sentence the tenant can read. Infrastructure wording is dropped. */
export function platformSentence(value: string | undefined, max = 200): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const text = sanitizePublicText(value, max).trim();
  if (text.length === 0 || text === '[redacted]' || INFRASTRUCTURE.test(text)) return undefined;
  return text;
}
