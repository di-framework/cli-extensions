/** Kubernetes namespaces are DNS labels, including an optional numeric first character. */
export function isNamespace(value: string): boolean {
  return value.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);
}
