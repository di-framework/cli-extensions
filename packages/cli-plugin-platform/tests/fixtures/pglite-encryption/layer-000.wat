;; Exports types@0.0.3 for a provider importing 0.0.2: not the same semver track.
(component
  ;; The marker the platform pglite-encfs component carries; these stand-ins pass data through.
  (@custom "di-framework:pglite-encfs" "format=1 codec=test-passthrough")
  (import "wasi:filesystem/types@0.0.2" (instance $host-types (export "stat" (func (result u32)))))
  (import "wasi:cli/environment@0.2.9" (instance $host-env (export "get-environment" (func (result u32)))))
  (alias export $host-types "stat" (func $stat))
  (instance $types (export "stat" (func $stat)))
  (export "wasi:filesystem/types@0.0.3" (instance $types))
  (alias export $host-env "get-environment" (func $getenv))
  (instance $env (export "get-environment" (func $getenv)))
  (export "wasi:cli/environment@0.2.9" (instance $env))
)
