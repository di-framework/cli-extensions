import * as fs from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import type { DiscoveryConfig } from './manifest';
import { ALWAYS_SKIP_DIRECTORIES } from './manifest';
import { isInside } from './paths';
import { CONFIG_FILE_NAME, loadProject, type WasmcloudProject } from './project';

export type DiscoveredProjects = Map<string, WasmcloudProject>;

export function discoverProjects(
  workspaceRoot: string,
  discovery: DiscoveryConfig,
): DiscoveredProjects {
  const configs = findConfigFiles(workspaceRoot, discovery);
  const byName = new Map<string, WasmcloudProject[]>();

  for (const configPath of configs) {
    const project = loadProject(configPath);
    const existing = byName.get(project.applicationName) ?? [];
    existing.push(project);
    byName.set(project.applicationName, existing);
  }

  const duplicates = [...byName.entries()].filter(([, projects]) => projects.length > 1);
  if (duplicates.length > 0) {
    const [name, projects] = duplicates[0] ?? ['', []];
    const paths = projects.map((project) => project.configPath);
    throw new CommandFailure(
      'WASMCLOUD_DUPLICATE_PROJECT',
      `Duplicate project name "${name}" found in:\n${paths.map((path) => `  ${path}`).join('\n')}`,
      2,
      { name, paths },
    );
  }

  return new Map(
    [...byName.entries()].map(([name, projects]) => [name, projects[0] as WasmcloudProject]),
  );
}

export function resolveApplication(
  startDirectory: string,
  name: string | undefined,
  workspaceRoot: string,
  discovery: DiscoveryConfig,
): WasmcloudProject {
  if (name === undefined) {
    const project = loadProject(startDirectory);
    if (!isInside(workspaceRoot, project.projectRoot)) {
      throw new CommandFailure(
        'WASMCLOUD_PROJECT_NOT_FOUND',
        `Nearest project ${project.configPath} is outside the workspace ${workspaceRoot}`,
        2,
        { startDirectory, configPath: project.configPath, workspaceRoot },
      );
    }
    return project;
  }

  const projects = discoverProjects(workspaceRoot, discovery);
  const match = projects.get(name);
  if (match === undefined) {
    const known = [...projects.keys()].sort();
    throw new CommandFailure(
      'WASMCLOUD_PROJECT_NOT_FOUND',
      known.length === 0
        ? `No project named "${name}" found in the workspace.`
        : `No project named "${name}" found in the workspace. Known projects: ${known.join(', ')}`,
      2,
      { name, workspaceRoot, known },
    );
  }
  return match;
}

export function findConfigFiles(workspaceRoot: string, discovery: DiscoveryConfig): string[] {
  const logicalRoot = resolve(workspaceRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(logicalRoot);
  } catch {
    return [];
  }
  const matches: string[] = [];
  const visited = new Set<string>();
  walk(logicalRoot, realRoot, logicalRoot, discovery, visited, matches);
  return matches.sort();
}

function walk(
  logicalRoot: string,
  realRoot: string,
  directory: string,
  discovery: DiscoveryConfig,
  visited: Set<string>,
  matches: string[],
): void {
  let realDirectory: string;
  try {
    realDirectory = fs.realpathSync(directory);
  } catch {
    return;
  }
  if (visited.has(realDirectory) || !isInside(realRoot, realDirectory)) return;
  visited.add(realDirectory);

  for (const entry of readDirents(directory)) {
    const fullPath = join(directory, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      let realPath: string;
      try {
        realPath = fs.realpathSync(fullPath);
      } catch {
        continue;
      }
      if (!isInside(realRoot, realPath)) continue;
      const stated = statLinkTarget(realPath);
      if (stated === undefined) continue;
      isDirectory = stated.isDirectory;
      isFile = stated.isFile;
      if (isDirectory && visited.has(realPath)) continue;
    }

    if (isDirectory) {
      if (ALWAYS_SKIP_DIRECTORIES.has(entry.name)) continue;
      const relativeDirectory = relativePath(logicalRoot, fullPath);
      if (isExcluded(relativeDirectory, discovery.exclude)) continue;
      walk(logicalRoot, realRoot, fullPath, discovery, visited, matches);
      continue;
    }

    if (isFile && entry.name === CONFIG_FILE_NAME) {
      const relativeFile = relativePath(logicalRoot, fullPath);
      if (isExcluded(relativeFile, discovery.exclude)) continue;
      if (!isIncluded(relativeFile, discovery.include)) continue;
      try {
        if (fs.lstatSync(fullPath).isSymbolicLink()) {
          const realPath = fs.realpathSync(fullPath);
          if (!isInside(realRoot, realPath)) continue;
        }
      } catch {
        continue;
      }
      matches.push(fullPath);
    }
  }
}

export function readDirents(directory: string): fs.Dirent[] {
  try {
    return [...fs.readdirSync(directory, { withFileTypes: true })];
  } catch {
    return [];
  }
}

export function statLinkTarget(
  path: string,
): { isDirectory: boolean; isFile: boolean } | undefined {
  try {
    const stat = fs.statSync(path);
    return { isDirectory: stat.isDirectory(), isFile: stat.isFile() };
  } catch {
    return undefined;
  }
}

function relativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

export function isIncluded(relativeFile: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchGlob(relativeFile, pattern));
}

export function isExcluded(relativePathValue: string, patterns: readonly string[]): boolean {
  return patterns.some(
    (pattern) =>
      matchGlob(relativePathValue, pattern) || matchGlob(`${relativePathValue}/**`, pattern),
  );
}

export function matchGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern.replaceAll('\\', '/')).test(path.replaceAll('\\', '/'));
}

function globToRegExp(pattern: string): RegExp {
  let index = 0;
  let source = '^';
  const normalized = pattern.replace(/^\.\//, '');
  while (index < normalized.length) {
    const character = normalized[index] ?? '';
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (character === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if ('\\^$+{}()|[]'.includes(character)) source += `\\${character}`;
    else source += character;
    index += 1;
  }
  source += '$';
  return new RegExp(source);
}
