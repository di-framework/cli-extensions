;; Stand-in for a wrong artifact: exports only wasi:cli/environment and never touches the
;; filesystem, so `wac plug` composes it and the provider's filesystem goes straight to the host.
(component
  (import "wasi:cli/environment@0.2.9" (instance $host-env (export "get-environment" (func (result u32)))))
  (alias export $host-env "get-environment" (func $getenv))
  (instance $env (export "get-environment" (func $getenv)))
  (export "wasi:cli/environment@0.2.9" (instance $env))
)
