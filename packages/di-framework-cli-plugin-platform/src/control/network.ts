/** Cluster-only exposure for `/_di/*` and `/_actors/*` on deployed HTTP. */

const FORWARDED_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-by',
] as const;

export function requestHostname(request: Request): string {
  const header = request.headers.get('host');
  const host = header && header.trim() !== '' ? header : new URL(request.url).host;
  return host.trim().split(':')[0] ?? '';
}

export function isForwardedRequest(request: Request): boolean {
  return FORWARDED_HEADERS.some((name) => {
    const value = request.headers.get(name);
    return value !== null && value.trim() !== '';
  });
}

export function controlHttpHostList(
  raw: string | undefined = process.env.DI_CONTROL_HTTP_HOST,
): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Deployed workloads set `DI_CONTROL_REJECT_FORWARDED=1` and
 * `DI_CONTROL_HTTP_HOST` so control paths are not reachable through public
 * ingress. Unconfigured local/dev leaves both unset and stays open (auth still
 * applies).
 */
export function allowControlSurface(request: Request): boolean {
  const rejectForwarded = process.env.DI_CONTROL_REJECT_FORWARDED === '1';
  const allowedHosts = controlHttpHostList();
  if (!rejectForwarded && allowedHosts.length === 0) return true;
  if (rejectForwarded && isForwardedRequest(request)) return false;
  if (allowedHosts.length === 0) return true;
  return allowedHosts.includes(requestHostname(request));
}

export function controlSurfaceNotFound(): Response {
  return new Response(JSON.stringify({ success: false, error: 'Not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
