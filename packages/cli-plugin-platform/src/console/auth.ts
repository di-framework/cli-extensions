import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'di_console_session';
export const CSRF_HEADER = 'x-di-console-csrf';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;

export type Session = {
  csrf: string;
  expiresAt: number;
  createdAt: number;
};

export type SessionStore = {
  create(now?: number): { id: string; session: Session };
  read(id: string | undefined, now: number): Session | undefined;
  destroy(id: string | undefined): void;
};

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    create(now = Date.now()) {
      for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
      }
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      const id = randomBytes(32).toString('base64url');
      const session: Session = {
        csrf: randomBytes(32).toString('base64url'),
        expiresAt: now + SESSION_TTL_MS,
        createdAt: now,
      };
      sessions.set(id, session);
      return { id, session };
    },
    read(id, now) {
      if (id === undefined || id.length === 0) return undefined;
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      if (session.expiresAt <= now) {
        sessions.delete(id);
        return undefined;
      }
      return session;
    },
    destroy(id) {
      if (id !== undefined) sessions.delete(id);
    },
  };
}

export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const left = createHash('sha256').update(provided).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length === 0) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) !== name) continue;
    const raw = trimmed.slice(separator + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookie(id: string, maxAge: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ].join('; ');
}
