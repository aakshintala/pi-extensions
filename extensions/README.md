# Executed extension code lives here.

Each extension is an entry point matched by the `pi.extensions` manifest in
the root `package.json`:

- `./<name>.ts` — single-file extension
- `./<name>/index.ts` — multi-file extension (`index.ts` organizes the rest)

Every entry point default-exports a factory function receiving pi's
`ExtensionAPI` (factory shape and event list: pi `docs/extensions.md`).

## Factory rules

- Registration + cheap synchronous setup only (`pi.on`,
  `pi.registerTool`, `pi.registerCommand`, ...). Never return a promise
  from the factory unless fetching one-time startup config.
- Never start long-lived resources from the factory: no network,
  processes, sockets, watchers, or timers. Factories can run where no
  session ever starts.
- Start session-scoped resources from `session_start`, or from the
  command/tool/event that needs them.
- Every long-lived resource gets an idempotent `session_shutdown`
  handler that releases it; running cleanup twice must be a safe no-op.
- Dependency-free and credential-free: `node:` built-ins plus the pi API
  only. (`pi install` uses `--omit=dev`, so anything a distributed
  package needs at runtime must be in `dependencies` — this package
  ships none.)
