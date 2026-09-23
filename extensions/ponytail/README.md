# ponytail

Adds one short `<ponytail>` section to the system prompt on every agent run: build the simplest thing that works, climb the reuse ladder (existing code, stdlib, platform, installed dependency, new code), fix bugs at the root cause, and never simplify away validation, data-loss handling, security or accessibility.

The section is set through Pi's system-prompt sections in `before_agent_start`, so other extensions' sections and prompt caching are left intact. It costs about 155 tokens.

Rebuilt from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT); see `upstream/ponytail/`.

## Skills

- `ponytail-audit` (in `skills/`): whole-repo audit for over-engineering. Run it with `/skill:ponytail-audit`.

## Tools, commands, keys, settings

None.
