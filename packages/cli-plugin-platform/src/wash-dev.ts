import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { BindingRecord } from './bindings';
import { type HostInterface, hostInterfacesFromRequirements, yamlQuote } from './host-interface';
import type { WasmcloudProject } from './project';
import type { WitRequirement } from './wit';

export const WASH_DEV_CONFIG_NAME = 'wash-dev.yaml';

export type WashDevConfigOptions = {
  componentPath: string;
  host: string;
  port: string;
  postgresUrl?: string;
};

export function washDevConfigPath(project: WasmcloudProject): string {
  return join(project.projectRoot, '.di-framework', WASH_DEV_CONFIG_NAME);
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

export function renderWashDevYaml(
  interfaces: readonly HostInterface[],
  options: WashDevConfigOptions,
): string {
  const lines = [
    'version: 2.5.2',
    'build:',
    '  command: "true"',
    `  component_path: ${yamlQuote(options.componentPath)}`,
    'dev:',
    `  address: ${yamlQuote(`${options.host}:${options.port}`)}`,
    '  wasm_proposals:',
    '    - component-model-async',
  ];
  if (options.postgresUrl !== undefined && options.postgresUrl !== '') {
    lines.push(`  postgres_url: ${yamlQuote(options.postgresUrl)}`);
  }
  if (interfaces.length > 0) {
    lines.push('  host_interfaces:');
    for (const entry of interfaces) {
      if (entry.name !== undefined) {
        lines.push(`    - name: ${yamlQuote(entry.name)}`);
        lines.push(`      namespace: ${entry.namespace}`);
      } else {
        lines.push(`    - namespace: ${entry.namespace}`);
      }
      lines.push(`      package: ${entry.package}`);
      lines.push(`      version: ${yamlQuote(entry.version)}`);
      lines.push('      interfaces:');
      for (const iface of entry.interfaces) lines.push(`        - ${iface}`);
      if (entry.config !== undefined) {
        lines.push('      config:');
        for (const [key, value] of Object.entries(entry.config)) {
          lines.push(`        ${yamlQuote(key)}: ${yamlQuote(value)}`);
        }
      }
      if (entry.configFrom !== undefined) {
        lines.push('      configFrom:');
        for (const ref of entry.configFrom) {
          lines.push(`        - name: ${yamlQuote(ref.name)}`);
        }
      }
      if (entry.secretFrom !== undefined) {
        lines.push('      secretFrom:');
        for (const ref of entry.secretFrom) {
          lines.push(`        - name: ${yamlQuote(ref.name)}`);
        }
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function writeWashDevConfig(
  project: WasmcloudProject,
  requirements: readonly WitRequirement[],
  bindings: readonly BindingRecord[],
  options: { host: string; port: string; postgresUrl?: string },
): string {
  const path = washDevConfigPath(project);
  mkdirSync(dirname(path), { recursive: true });
  const interfaces = hostInterfacesFromRequirements(
    requirements,
    { httpHost: options.host },
    bindings.map((binding) => ({
      name: binding.name,
      className: binding.className,
      config: binding.config,
      configFrom: binding.configFrom,
      secretFrom: binding.secretFrom,
    })),
  );
  writeFileSync(
    path,
    renderWashDevYaml(interfaces, {
      componentPath: posixRelative(project.projectRoot, project.outputPath),
      host: options.host,
      port: options.port,
      postgresUrl: options.postgresUrl,
    }),
  );
  return path;
}
