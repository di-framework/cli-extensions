;; Right names and versions, wrong types: its filesystem functions return u64 where the
;; provider expects u32. `wac plug` skips such an export silently; `wac compose` refuses it.
(component
  (import "wasi:filesystem/types@0.2.9" (instance $host-types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $host-preopens (export "get-directories" (func (result u32)))))
  (import "wasi:cli/environment@0.2.9" (instance $host-env (export "get-environment" (func (result u32)))))
  (import "bogus-types" (func $bt (result u64)))
  (import "bogus-dirs" (func $bd (result u64)))
  (instance $types (export "stat" (func $bt)))
  (export "wasi:filesystem/types@0.2.9" (instance $types))
  (instance $preopens (export "get-directories" (func $bd)))
  (export "wasi:filesystem/preopens@0.2.9" (instance $preopens))
  (alias export $host-env "get-environment" (func $getenv))
  (instance $env (export "get-environment" (func $getenv)))
  (export "wasi:cli/environment@0.2.9" (instance $env))
)
