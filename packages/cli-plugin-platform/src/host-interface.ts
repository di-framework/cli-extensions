import {
  type AggregatedRequirement,
  aggregateRequirements,
  parsePackageId,
  WASI_HTTP_INTERFACE,
  WASI_HTTP_PACKAGE,
  WASI_RANDOM_PACKAGE,
  WASI_SOCKETS_PACKAGE,
  type WitRequirement,
} from './wit';

export type HostInterface = {
  name?: string;
  namespace: string;
  package: string;
  version: string;
  interfaces: string[];
  config?: Record<string, string>;
  configFrom?: Array<{ name: string }>;
  secretFrom?: Array<{ name: string }>;
};

export type HostInterfaceOptions = {
  httpHost?: string;
  subscriptions?: string[];
};

export type BindingHostOverlay = {
  name: string;
  className: string;
  config?: Record<string, string>;
  configFrom?: string;
  secretFrom?: string;
};

// These providers link QuickJS's unlabeled imports through their default route.
// Supplying a name selects the implements route, which cannot link those imports.
const UNLABELED_HOST_PACKAGES = new Set([
  'wasmcloud:postgres',
  'wasmcloud:keyvalue',
  'wasmcloud:blobstore',
  'wasmcloud:messaging',
  'wasmcloud:secrets',
]);

function hostInterfaceFromRequirement(
  requirement: AggregatedRequirement,
  options: HostInterfaceOptions,
): HostInterface {
  const { namespace, name } = parsePackageId(requirement.package);
  const entry: HostInterface = {
    namespace,
    package: name,
    version: requirement.version,
    // Key-value resource types are linked internally, not advertised by the provider.
    interfaces:
      requirement.package === 'wasmcloud:keyvalue' ||
      (requirement.package === 'wasmcloud:postgres' &&
        requirement.interfaces.every((iface) => iface === 'types'))
        ? requirement.interfaces.filter((iface) => iface !== 'types')
        : [...requirement.interfaces],
  };
  if (
    requirement.instanceName !== undefined &&
    (requirement.namedImport || !UNLABELED_HOST_PACKAGES.has(requirement.package))
  ) {
    entry.name = requirement.instanceName;
  }
  if (
    requirement.package === WASI_HTTP_PACKAGE &&
    requirement.interfaces.includes(WASI_HTTP_INTERFACE) &&
    options.httpHost !== undefined
  ) {
    entry.config = { host: options.httpHost };
  }
  if (requirement.package === 'wasmcloud:messaging' && options.subscriptions) {
    entry.config = { ...entry.config, subscriptions: options.subscriptions.join(',') };
  }
  return entry;
}

export function hostInterfacesFromRequirements(
  requirements: readonly WitRequirement[],
  options: HostInterfaceOptions = {},
  overlays: readonly BindingHostOverlay[] = [],
): HostInterface[] {
  const byName = new Map(overlays.map((overlay) => [overlay.name, overlay]));
  const entries = aggregateRequirements(requirements)
    .filter(
      (requirement) =>
        requirement.package !== WASI_SOCKETS_PACKAGE &&
        requirement.package !== WASI_RANDOM_PACKAGE &&
        requirement.package !== 'wasi:tls' &&
        requirement.package !== 'wasi:clocks',
    )
    .map((requirement) => {
      const entry = hostInterfaceFromRequirement(requirement, options);
      const overlay =
        requirement.instanceName !== undefined
          ? (byName.get(requirement.instanceName) ??
            (requirement.namedImport
              ? overlays.find((candidate) => requirement.sources.includes(candidate.className))
              : undefined))
          : overlays.find((candidate) => requirement.sources.includes(candidate.className));
      if (
        requirement.package === 'wasmcloud:postgres' &&
        requirement.interfaces.every((iface) => iface === 'types')
      )
        return entry;
      if (overlay === undefined) return entry;
      if (overlay.config !== undefined) {
        entry.config = { ...entry.config, ...overlay.config };
      }
      if (overlay.configFrom !== undefined) entry.configFrom = [{ name: overlay.configFrom }];
      if (overlay.secretFrom !== undefined) entry.secretFrom = [{ name: overlay.secretFrom }];
      return entry;
    });
  return mergeHttpHostInterfaces(entries);
}

function mergeHttpHostInterfaces(entries: HostInterface[]): HostInterface[] {
  const merged: HostInterface[] = [];
  for (const entry of entries) {
    // Import/export directions belong to the WIT world, but the CRD requires one
    // unnamed host entry per package/version. Preserve overlays from both sides.
    const existing =
      ((entry.namespace === 'wasi' && entry.package === 'http') ||
        (entry.namespace === 'wasmcloud' && entry.package === 'messaging')) &&
      entry.name === undefined
        ? merged.find(
            (candidate) =>
              candidate.namespace === entry.namespace &&
              candidate.package === entry.package &&
              candidate.version === entry.version &&
              candidate.name === undefined,
          )
        : undefined;
    if (existing === undefined) {
      merged.push(entry);
      continue;
    }
    existing.interfaces = [...new Set([...existing.interfaces, ...entry.interfaces])];
    if (entry.config !== undefined) existing.config = { ...existing.config, ...entry.config };
    if (entry.configFrom !== undefined) {
      existing.configFrom = [...(existing.configFrom ?? []), ...entry.configFrom];
    }
    if (entry.secretFrom !== undefined) {
      existing.secretFrom = [...(existing.secretFrom ?? []), ...entry.secretFrom];
    }
  }
  // The core links wasi:http/client; only handler is advertised by the ingress
  // provider. This changes host discovery, never the guest's WIT imports.
  return merged
    .map((entry) =>
      entry.namespace === 'wasi' && entry.package === 'http'
        ? { ...entry, interfaces: entry.interfaces.filter((iface) => iface !== 'client') }
        : entry,
    )
    .filter((entry) => entry.interfaces.length > 0);
}

export function renderHostInterfacesYaml(interfaces: readonly HostInterface[]): string {
  if (interfaces.length === 0) return '';
  const lines = ['      hostInterfaces:'];
  for (const entry of interfaces) {
    if (entry.name !== undefined) {
      lines.push(`        - name: ${yamlQuote(entry.name)}`);
      lines.push(`          namespace: ${entry.namespace}`);
    } else {
      lines.push(`        - namespace: ${entry.namespace}`);
    }
    lines.push(`          package: ${entry.package}`);
    lines.push(`          version: ${yamlQuote(entry.version)}`);
    lines.push('          interfaces:');
    for (const iface of entry.interfaces) lines.push(`            - ${iface}`);
    if (entry.config !== undefined) {
      lines.push('          config:');
      for (const [key, value] of Object.entries(entry.config)) {
        lines.push(`            ${yamlQuote(key)}: ${yamlQuote(value)}`);
      }
    }
    if (entry.configFrom !== undefined) {
      lines.push('          configFrom:');
      for (const ref of entry.configFrom) lines.push(`            - name: ${yamlQuote(ref.name)}`);
    }
    if (entry.secretFrom !== undefined) {
      lines.push('          secretFrom:');
      for (const ref of entry.secretFrom) lines.push(`            - name: ${yamlQuote(ref.name)}`);
    }
  }
  return lines.join('\n');
}

export function yamlQuote(value: string): string {
  return JSON.stringify(value);
}
