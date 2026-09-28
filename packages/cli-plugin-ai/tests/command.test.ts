import { describe, expect, it } from 'bun:test';
import extension, { createAiCommand } from '../src/index.ts';

describe('ai extension', () => {
  it('mounts agent and skills under the ai command', () => {
    expect(extension.name).toBe('ai');
    expect(extension.schemaVersion).toBe(1);
    const command = createAiCommand();
    expect(command.children?.agent?.children?.audit?.run).toBeFunction();
    expect(command.children?.agent?.children?.init?.run).toBeFunction();
    expect(command.children?.agent?.children?.inspect?.run).toBeFunction();
    expect(command.children?.agent?.children?.migrate?.run).toBeFunction();
    expect(command.children?.skills?.children?.validate?.run).toBeFunction();
    expect(command.children?.skills?.children?.index?.children?.build?.run).toBeFunction();
    expect(command.children?.skills?.children?.index?.children?.query?.usage).toBe(
      'di-framework ai skills index query --query <text> [options]',
    );
  });
});
