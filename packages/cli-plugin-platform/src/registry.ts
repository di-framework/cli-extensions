export type RegistryLocation = {
  /** Host-side endpoint used by ORAS. May include http:// or https://. */
  push: string;
  /** Cluster-side endpoint embedded in workload OCI references. */
  pull: string;
  /** Explicitly permits plain HTTP for the push endpoint. */
  insecure: boolean;
};

export type RegistryInput =
  | string
  | {
      push: string;
      pull: string;
      insecure?: boolean;
    };

export function materializeRegistry(input: RegistryInput): RegistryLocation {
  if (typeof input === 'string') {
    return { push: input, pull: input, insecure: usesHttp(input) };
  }
  return {
    push: input.push,
    pull: input.pull,
    insecure: input.insecure ?? usesHttp(input.push),
  };
}

export function registryUsesPlainHttp(registry: RegistryLocation): boolean {
  return registry.insecure || usesHttp(registry.push);
}

export function registryReferenceHost(registry: string): string {
  let host = registry.trim();
  const lower = host.toLowerCase();
  if (lower.startsWith('https://')) host = host.slice('https://'.length);
  else if (lower.startsWith('http://')) host = host.slice('http://'.length);
  while (host.endsWith('/')) host = host.slice(0, -1);
  return host;
}

function usesHttp(value: string): boolean {
  return value.trim().toLowerCase().startsWith('http://');
}
