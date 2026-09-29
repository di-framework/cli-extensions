import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

test('cli-extensions publishes the platform and ai plugins', () => {
  expect(existsSync('packages/cli-plugin-platform/package.json')).toBe(true);
  expect(existsSync('packages/cli-plugin-ai/package.json')).toBe(true);
});
