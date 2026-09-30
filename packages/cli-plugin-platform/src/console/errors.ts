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

/** Remove credential-shaped substrings before text is shown or logged. */
export function sanitizePublicText(value: string, max = 400): string {
  const text = value
    .replace(BEARER, '[redacted]')
    .replace(ASSIGNED_SECRET, '[redacted]')
    .replace(LONG_TOKEN, '[redacted]');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
