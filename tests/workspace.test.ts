import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

test('cli-extensions publishes the platform plugin', () => {
  expect(existsSync('packages/di-framework-cli-plugin-platform/package.json')).toBe(true);
});
