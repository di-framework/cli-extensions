;; Imports wasi:filesystem/types at two versions; the layer exports only 0.2.9.
(component
  (import "wasi:filesystem/types@0.2.9" (instance $types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/types@0.3.0" (instance $types3 (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $preopens (export "get-directories" (func (result u32)))))
  (alias export $types3 "stat" (func $stat))
  (instance $database (export "open" (func $stat)))
  (export "di-framework:pglite/database@0.2.0" (instance $database))
)
