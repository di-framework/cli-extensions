/**
 * Denial messages of the platform's Secret admission policies, matched by substring in kubectl
 * stderr (kubectl prefixes them with the policy and binding names). The source of truth is
 * di-framework/platform `platform/platform/src/tenancy/admission.ts`:
 * `SECRET_UPDATE_KEYS_MESSAGE` and `SECRET_UPDATE_MANAGED_MESSAGE` of the `tenant-secret-update`
 * ValidatingAdmissionPolicy (platform#112, PR #114), and the message of the older
 * `backend-config` policy, which a managed name can trip first. If the platform rewords one,
 * the matching mapping here silently falls through to a generic error, so change both together.
 */
export const SECRET_UPDATE_KEYS_MESSAGE =
  'tenant users may update a Secret only if it keeps every existing data key';
export const SECRET_UPDATE_MANAGED_MESSAGE =
  'tenant users cannot update platform-managed di-binding-*/di-bs-* Secrets';
export const BACKEND_CONFIG_MANAGED_MESSAGE =
  'di-tenant-stock, di-platform-routes, di-bs-*, and di-binding-* ConfigMaps/Secrets are managed by the platform controller';
export const MANAGED_SECRET_DENIALS = [
  SECRET_UPDATE_MANAGED_MESSAGE,
  BACKEND_CONFIG_MANAGED_MESSAGE,
] as const;

/**
 * The Kubernetes Status reason of a failed kubectl request, from its
 * `Error from server (<Reason>): …` line. Matching the reason rather than free text keeps a
 * resource name such as `notfound-creds` from changing how an error is classified.
 */
export function kubectlStatusReason(stderr: string): string | undefined {
  return /Error from server \(([A-Za-z]+)\)/.exec(stderr)?.[1];
}
