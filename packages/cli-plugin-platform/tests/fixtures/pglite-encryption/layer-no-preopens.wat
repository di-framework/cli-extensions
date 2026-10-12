;; Stand-in encryption layer: imports the host filesystem, re-exports: types env
(component
  (import "wasi:filesystem/types@0.2.9" (instance $host-types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $host-preopens (export "get-directories" (func (result u32)))))
  (import "wasi:cli/environment@0.2.9" (instance $host-env (export "get-environment" (func (result u32)))))
  (alias export $host-types "stat" (func $stat))
  (instance $types (export "stat" (func $stat)))
  (export "wasi:filesystem/types@0.2.9" (instance $types))
  (alias export $host-env "get-environment" (func $getenv))
  (instance $env (export "get-environment" (func $getenv)))
  (export "wasi:cli/environment@0.2.9" (instance $env))
)
