;; Exports the filesystem at 0.2.8 for a provider importing 0.2.9: the same 0.2 track for wac.
(component
  (import "wasi:filesystem/types@0.2.9" (instance $host-types (export "stat" (func (result u32)))))
  (import "wasi:filesystem/preopens@0.2.9" (instance $host-preopens (export "get-directories" (func (result u32)))))
  (alias export $host-types "stat" (func $stat))
  (instance $types (export "stat" (func $stat)))
  (export "wasi:filesystem/types@0.2.8" (instance $types))
  (alias export $host-preopens "get-directories" (func $dirs))
  (instance $preopens (export "get-directories" (func $dirs)))
  (export "wasi:filesystem/preopens@0.2.8" (instance $preopens))
)
