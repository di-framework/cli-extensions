;; Reaches storage through a plain-named interface that jco prints as an inline `import fs: interface {`.
(component
  (import "wasi:filesystem/types@0.2.9" (instance $types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $preopens (export "get-directories" (func (result u32)))))
  (import "fs" (instance $fs (export "stat" (func (result u32)))))
  (alias export $fs "stat" (func $stat))
  (instance $database (export "open" (func $stat)))
  (export "di-framework:pglite/database@0.2.0" (instance $database))
)
