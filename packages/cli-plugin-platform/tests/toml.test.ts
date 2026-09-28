import { describe, expect, it } from 'bun:test';
import { parseToml, TomlParseError } from '../src/toml';

describe('parseToml', () => {
  it('parses tables, dotted keys, strings, arrays, and comments', () => {
    const parsed = parseToml(`
# workspace
default-target = "local"

[discovery]
include = ["services/**", "nested/**"]
exclude = ["vendor/**"]

[targets.local]
platform = "deploy/platform"
stack = "dev"

[targets.development]
kubeconfig = "\${KUBECONFIG}"
namespace = "wasmcloud"
`);
    expect(parsed['default-target']).toBe('local');
    expect(parsed.discovery).toEqual({
      include: ['services/**', 'nested/**'],
      exclude: ['vendor/**'],
    });
    expect(parsed.targets).toEqual({
      local: { platform: 'deploy/platform', stack: 'dev' },
      development: { kubeconfig: `\${KUBECONFIG}`, namespace: 'wasmcloud' },
    });
  });

  it('parses booleans used by registry transport configuration', () => {
    expect(parseToml('[target.registry]\ninsecure = true\nsecure = false\n')).toEqual({
      target: { registry: { insecure: true, secure: false } },
    });
  });

  it('rejects malformed documents with a line number', () => {
    expect(() => parseToml('default-target = local')).toThrow(TomlParseError);
    try {
      parseToml('ok = "yes"\nbroken');
    } catch (error) {
      expect(error).toMatchObject({ name: 'TomlParseError', line: 2 });
    }
  });
});
