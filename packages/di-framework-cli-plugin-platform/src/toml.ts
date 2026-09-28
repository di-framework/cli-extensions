/** Minimal TOML parser for `di-framework.deploy.toml`. */

export class TomlParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'TomlParseError';
  }
}

export function parseToml(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index] ?? '').trim();
    if (line === '') continue;

    if (line.startsWith('[')) {
      if (!line.endsWith(']')) {
        throw new TomlParseError(`Unclosed table header: ${line}`, lineNumber);
      }
      const header = line.slice(1, -1).trim();
      if (header === '' || header.startsWith('[')) {
        throw new TomlParseError(`Array tables are not supported: ${line}`, lineNumber);
      }
      current = ensureTable(root, splitDottedKeys(header, lineNumber), lineNumber);
      continue;
    }

    const equals = findUnquotedEquals(line);
    if (equals < 0) {
      throw new TomlParseError(`Expected key = value: ${line}`, lineNumber);
    }
    const key = line.slice(0, equals).trim();
    const rawValue = line.slice(equals + 1).trim();
    if (key === '') {
      throw new TomlParseError('Missing key before "="', lineNumber);
    }
    setValue(
      current,
      splitDottedKeys(key, lineNumber),
      parseValue(rawValue, lineNumber),
      lineNumber,
    );
  }

  return root;
}

function stripComment(line: string): string {
  let inString = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index] ?? '';
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\' && quote === '"') {
        escaped = true;
        continue;
      }
      if (character === quote) {
        inString = false;
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      inString = true;
      quote = character;
      continue;
    }
    if (character === '#') return line.slice(0, index);
  }
  return line;
}

function findUnquotedEquals(line: string): number {
  let inString = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index++) {
    const character = line[index] ?? '';
    if (inString) {
      if (character === quote) {
        inString = false;
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      inString = true;
      quote = character;
      continue;
    }
    if (character === '=') return index;
  }
  return -1;
}

function splitDottedKeys(header: string, lineNumber: number): string[] {
  const keys: string[] = [];
  let current = '';
  let inQuote = false;
  for (const character of header) {
    if (character === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (character === '.' && !inQuote) {
      if (current === '') {
        throw new TomlParseError(`Invalid dotted key: ${header}`, lineNumber);
      }
      keys.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (inQuote || current === '') {
    throw new TomlParseError(`Invalid dotted key: ${header}`, lineNumber);
  }
  keys.push(current);
  return keys;
}

function ensureTable(
  root: Record<string, unknown>,
  keys: readonly string[],
  lineNumber: number,
): Record<string, unknown> {
  let current = root;
  for (const key of keys) {
    const existing = current[key];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      current[key] = next;
      current = next;
      continue;
    }
    if (!isRecord(existing)) {
      throw new TomlParseError(`Cannot redefine "${key}" as a table`, lineNumber);
    }
    current = existing;
  }
  return current;
}

function setValue(
  table: Record<string, unknown>,
  keys: readonly string[],
  value: unknown,
  lineNumber: number,
): void {
  const last = keys[keys.length - 1];
  if (last === undefined) {
    throw new TomlParseError('Missing key', lineNumber);
  }
  const parent = keys.length === 1 ? table : ensureTable(table, keys.slice(0, -1), lineNumber);
  if (parent[last] !== undefined) {
    throw new TomlParseError(`Duplicate key "${keys.join('.')}"`, lineNumber);
  }
  parent[last] = value;
}

function parseValue(raw: string, lineNumber: number): unknown {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    return parseQuotedString(raw, lineNumber);
  }
  if (raw.startsWith('[')) {
    return parseStringArray(raw, lineNumber);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new TomlParseError(
    `Unsupported value "${raw}"; expected a quoted string, boolean, or an array of strings`,
    lineNumber,
  );
}

function parseQuotedString(raw: string, lineNumber: number): string {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.length < 2) {
    throw new TomlParseError(`Invalid string: ${raw}`, lineNumber);
  }
  let value = '';
  let escaped = false;
  for (let index = 1; index < raw.length; index++) {
    const character = raw[index] ?? '';
    if (escaped) {
      const escapedCharacter =
        character === 'n'
          ? '\n'
          : character === 't'
            ? '\t'
            : character === '\\' || character === '"' || character === "'"
              ? character
              : undefined;
      if (escapedCharacter === undefined) {
        throw new TomlParseError(`Unknown escape \\${character}`, lineNumber);
      }
      value += escapedCharacter;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (character === quote) {
      if (index !== raw.length - 1) {
        throw new TomlParseError(`Unexpected trailing characters: ${raw}`, lineNumber);
      }
      return value;
    }
    value += character;
  }
  throw new TomlParseError(`Unterminated string: ${raw}`, lineNumber);
}

function parseStringArray(raw: string, lineNumber: number): string[] {
  if (!raw.endsWith(']')) {
    throw new TomlParseError(`Unclosed array: ${raw}`, lineNumber);
  }
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  const values: string[] = [];
  let remaining = inner;
  while (remaining !== '') {
    remaining = remaining.trim();
    if (!remaining.startsWith('"') && !remaining.startsWith("'")) {
      throw new TomlParseError('Arrays may only contain quoted strings', lineNumber);
    }
    const quote = remaining[0] ?? '';
    let end = 1;
    let escaped = false;
    for (; end < remaining.length; end++) {
      const character = remaining[end] ?? '';
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\' && quote === '"') {
        escaped = true;
        continue;
      }
      if (character === quote) break;
    }
    if (end >= remaining.length) {
      throw new TomlParseError(`Unterminated string in array: ${raw}`, lineNumber);
    }
    values.push(parseQuotedString(remaining.slice(0, end + 1), lineNumber));
    remaining = remaining.slice(end + 1).trim();
    if (remaining.startsWith(',')) remaining = remaining.slice(1);
    else if (remaining !== '') {
      throw new TomlParseError(`Expected "," between array values: ${raw}`, lineNumber);
    }
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
