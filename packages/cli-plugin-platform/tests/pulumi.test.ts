import { describe, expect, it } from 'bun:test';
import { pulumiEnvironment, runPulumi } from '../src/pulumi';
import { fakeDeps } from './helpers';

describe('pulumi helpers', () => {
  it('defaults the Pulumi environment without overriding explicit settings', () => {
    const defaulted = pulumiEnvironment({ PATH: '/bin' });
    expect(defaulted.PULUMI_BACKEND_URL).toBe('file://~');
    expect(defaulted.PULUMI_CONFIG_PASSPHRASE).toBe('local-dev');
    expect(defaulted.PATH).toBe('/bin');

    const explicit = pulumiEnvironment({
      PULUMI_BACKEND_URL: 's3://state',
      PULUMI_CONFIG_PASSPHRASE: 'secret',
    });
    expect(explicit.PULUMI_BACKEND_URL).toBe('s3://state');
    expect(explicit.PULUMI_CONFIG_PASSPHRASE).toBe('secret');
  });

  it('maps a non-zero pulumi exit to WASMCLOUD_TOOL_FAILED', async () => {
    await expect(
      runPulumi(fakeDeps({ cwd: '/tmp', exitCodes: { 'pulumi up': 7 } }), ['up', '--yes'], '/tmp'),
    ).rejects.toMatchObject({ code: 'WASMCLOUD_TOOL_FAILED', exitCode: 3 });
  });
});
