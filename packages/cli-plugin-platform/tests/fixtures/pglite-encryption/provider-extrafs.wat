;; Imports a wasi:filesystem interface the layer does not export.
(component
  (import "wasi:filesystem/types@0.2.9" (instance $types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $preopens (export "get-directories" (func (result u32)))))
  (import "wasi:filesystem/extra@0.2.9" (instance $x (export "stat" (func (result u32)))))
  (alias export $x "stat" (func $stat))
  (instance $database (export "open" (func $stat)))
  (export "di-framework:pglite/database@0.2.0" (instance $database))
)
