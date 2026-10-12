;; Imports the host filesystem and re-exports it unchanged, without the pglite-encfs marker.
;; It wires like a real layer, so only the missing marker shows it is not one.
(component
  (import "wasi:filesystem/types@0.2.9" (instance $host-types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $host-preopens (export "get-directories" (func (result u32)))))
  (export "wasi:filesystem/types@0.2.9" (instance $host-types))
  (export "wasi:filesystem/preopens@0.2.9" (instance $host-preopens))
)
