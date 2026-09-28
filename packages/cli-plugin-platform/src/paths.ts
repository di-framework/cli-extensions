import { isAbsolute, relative, resolve, sep } from 'node:path';

export function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === '') return true;
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

export function resolveInsideRoot(
  root: string,
  value: string,
): { ok: true; path: string } | { ok: false } {
  const absolutePath = resolve(root, value);
  return isInside(root, absolutePath) && relative(resolve(root), absolutePath) !== ''
    ? { ok: true, path: absolutePath }
    : { ok: false };
}
