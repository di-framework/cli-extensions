;; Stand-in encryption layer: imports the host filesystem, re-exports: types preopens
(component
  ;; The marker the platform pglite-encfs component carries; these stand-ins pass data through.
  (@custom "di-framework:pglite-encfs" "format=1 codec=test-passthrough")
  (import "wasi:filesystem/types@0.2.9" (instance $host-types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $host-preopens (export "get-directories" (func (result u32)))))
  (import "wasi:cli/environment@0.2.9" (instance $host-env (export "get-environment" (func (result u32)))))
  (alias export $host-types "stat" (func $stat))
  (instance $types (export "stat" (func $stat)))
  (export "wasi:filesystem/types@0.2.10" (instance $types))
  (alias export $host-preopens "get-directories" (func $dirs))
  (instance $preopens (export "get-directories" (func $dirs)))
  (export "wasi:filesystem/preopens@0.2.10" (instance $preopens))
)
