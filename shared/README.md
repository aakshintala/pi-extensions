# Shared libraries live here.

Helpers shared by two or more extensions. Extract on second use, never
speculatively — the first use stays inside its extension.

- Plain TypeScript modules, no side effects on import.
- No pi lifecycle handling here: extensions own registration, resource
  startup, and `session_shutdown` cleanup.
- Same dependency rule as `extensions/`: `node:` built-ins only.
