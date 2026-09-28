/** Cluster-private control-plane authentication for cron/queue/actor admin APIs. */

export type ControlIdentity = {
  id: string;
  token: string;
  roles: readonly string[];
};

export type ControlAuthResult =
  | { ok: true; identity: ControlIdentity }
  | { ok: false; status: number; error: string };

/** Unconfigured local/dev only. Never includes `admin`. */
const ANONYMOUS_IDENTITY: ControlIdentity = { id: 'anonymous', token: '', roles: ['invoke'] };

function isIdentityEntry(entry: unknown): entry is { id: string; token: string; roles?: unknown } {
  if (entry === null || typeof entry !== 'object') return false;
  const candidate = entry as { id?: unknown; token?: unknown };
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0
  );
}

function singleTokenIdentities(): ControlIdentity[] {
  const token = process.env.DI_CONTROL_TOKEN;
  if (typeof token !== 'string' || token.length === 0) return [];
  const id =
    typeof process.env.DI_CONTROL_IDENTITY === 'string' &&
    process.env.DI_CONTROL_IDENTITY.length > 0
      ? process.env.DI_CONTROL_IDENTITY
      : 'default';
  return [{ id, token, roles: ['invoke', 'admin'] }];
}

function parseIdentities(): { identities: ControlIdentity[]; configured: boolean } {
  const raw = process.env.DI_CONTROL_IDENTITIES;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const identities = parsed.filter(isIdentityEntry).map((entry) => {
          const roles = Array.isArray(entry.roles)
            ? entry.roles.filter((role): role is string => typeof role === 'string')
            : [];
          return {
            id: entry.id,
            token: entry.token,
            roles: roles.length > 0 ? roles : ['invoke'],
          };
        });
        if (identities.length > 0) return { identities, configured: true };
      }
    } catch {
      // Invalid JSON is still an attempted configuration.
    }
    return { identities: singleTokenIdentities(), configured: true };
  }
  const identities = singleTokenIdentities();
  return { identities, configured: identities.length > 0 };
}

function hasRequiredRole(identity: ControlIdentity, requiredRoles: readonly string[]): boolean {
  return !requiredRoles.some(
    (role) => !identity.roles.includes(role) && !identity.roles.includes('admin'),
  );
}

export function authorizeControlRequest(
  request: Request,
  requiredRoles: readonly string[] = ['invoke'],
): ControlAuthResult {
  const { identities, configured } = parseIdentities();
  if (identities.length === 0) {
    // Deployed workloads always wire DI_CONTROL_TOKEN. Unconfigured local/dev
    // may invoke, but never administer.
    if (configured || !hasRequiredRole(ANONYMOUS_IDENTITY, requiredRoles)) {
      return {
        ok: false,
        status: configured ? 401 : 403,
        error: configured ? 'Missing control credentials' : 'Insufficient control privileges',
      };
    }
    return { ok: true, identity: ANONYMOUS_IDENTITY };
  }

  const header = request.headers.get('authorization') ?? request.headers.get('x-di-control-token');
  if (!header) {
    return { ok: false, status: 401, error: 'Missing control credentials' };
  }
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice('bearer '.length).trim()
    : header.trim();
  const identity = identities.find((entry) => entry.token === token);
  if (!identity) {
    return { ok: false, status: 403, error: 'Unauthorized control credentials' };
  }
  if (!hasRequiredRole(identity, requiredRoles)) {
    return { ok: false, status: 403, error: 'Insufficient control privileges' };
  }
  return { ok: true, identity };
}

export function unauthorizedResponse(result: Extract<ControlAuthResult, { ok: false }>): Response {
  return new Response(JSON.stringify({ success: false, error: result.error }), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}
