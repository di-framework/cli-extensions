/**
 * OCI config for published components. wasmCloud/ORAS treat component artifacts
 * as `architecture: wasm` with the historical `wasip2` OS field; that names the
 * artifact type, not the WASI preview the guest was compiled for.
 */
export const OCI_ARTIFACT_PLATFORM = {
  architecture: 'wasm',
  os: 'wasip2',
} as const;
