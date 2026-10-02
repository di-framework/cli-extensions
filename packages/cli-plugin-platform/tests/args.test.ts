import { describe, expect, it } from 'bun:test';
import { parseAppCommandArgs, parsePlatformCommandArgs, parsePlatformInitArgs } from '../src/args';
import { expectFailure } from './helpers';

describe('parseAppCommandArgs', () => {
  it('parses an optional name, --target, and --yes', () => {
    expect(parseAppCommandArgs([], 'platform deploy')).toEqual({ yes: false });
    expect(parseAppCommandArgs(['greeter'], 'platform deploy')).toEqual({
      name: 'greeter',
      yes: false,
    });
    expect(
      parseAppCommandArgs(['greeter', '--target', 'development', '--yes'], 'platform deploy'),
    ).toEqual({ name: 'greeter', target: 'development', yes: true });
    expect(parseAppCommandArgs(['--target', 'local'], 'platform deploy')).toEqual({
      target: 'local',
      yes: false,
    });
  });

  it('rejects unknown options, extra positionals, and duplicates', () => {
    expectFailure(() => parseAppCommandArgs(['--bogus'], 'platform deploy'), 'INVALID_USAGE', 2);
    expectFailure(
      () => parseAppCommandArgs(['greeter', 'echo'], 'platform deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parseAppCommandArgs(['--yes', '--yes'], 'platform deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parseAppCommandArgs(['--target', '--yes'], 'platform deploy'),
      'INVALID_USAGE',
      2,
    );
  });
});

describe('parsePlatformInitArgs', () => {
  it('accepts --force and rejects anything else', () => {
    expect(parsePlatformInitArgs([])).toEqual({ force: false });
    expect(parsePlatformInitArgs(['--force'])).toEqual({ force: true });
    expect(parsePlatformInitArgs(['-f'])).toEqual({ force: true });
    expectFailure(() => parsePlatformInitArgs(['--yes']), 'INVALID_USAGE', 2);
    expectFailure(() => parsePlatformInitArgs(['local']), 'INVALID_USAGE', 2);
    expectFailure(() => parsePlatformInitArgs(['--force', '--force']), 'INVALID_USAGE', 2);
  });
});

describe('parsePlatformCommandArgs', () => {
  it('accepts an optional positional or --target name', () => {
    expect(parsePlatformCommandArgs(['local', '--yes'], 'platform cluster up')).toEqual({
      target: 'local',
      yes: true,
    });
    expect(parsePlatformCommandArgs(['--target', 'local'], 'platform cluster up')).toEqual({
      target: 'local',
      yes: false,
    });
    expect(parsePlatformCommandArgs([], 'platform cluster up')).toEqual({ yes: false });
    expect(parsePlatformCommandArgs(['--yes'], 'platform cluster up')).toEqual({ yes: true });
    expectFailure(
      () => parsePlatformCommandArgs(['--target', 'a', '--target', 'b'], 'platform cluster up'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parsePlatformCommandArgs(['--target'], 'platform cluster up'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parsePlatformCommandArgs(['--target', 'a', 'b'], 'platform cluster up'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parsePlatformCommandArgs(['local', 'extra'], 'platform cluster up'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parsePlatformCommandArgs(['local', '--unknown'], 'platform cluster up'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parsePlatformCommandArgs(['local', '--yes', '--yes'], 'platform cluster up'),
      'INVALID_USAGE',
      2,
    );
  });
});
