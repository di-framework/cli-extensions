;; Stand-in for the PGlite provider: imports the filesystem and environment, exports the database.
(component
  (import "wasi:filesystem/types@0.2.9" (instance $types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $preopens (export "get-directories" (func (result u32)))))
  (import "wasi:cli/environment@0.2.9" (instance $env (export "get-environment" (func (result u32)))))
  (alias export $types "stat" (func $stat))
  (instance $database (export "open" (func $stat)))
  (export "di-framework:pglite/database@0.2.0" (instance $database))
)
