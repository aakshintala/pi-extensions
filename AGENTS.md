# pi-rig

Customized Pi extensions maintained as a lightweight monorepo.

## Agent skills

### Issue tracker

Issues live in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one `CONTEXT.md` + `docs/adr/` at root, created lazily). See `docs/agents/domain.md`.

## Conventions

### Model-facing text

Write every tool description, parameter description, skill and injected reminder with the `writing-for-agents` skill, and keep it within the token budget the runtime audit enforces.

### READMEs

Keep READMEs *scannable*, modelled on [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions):

- **Root `README.md`:** a one-paragraph intro, how to install the rig, and one table with a row per extension: its name linked to its README, one line on what it is for, and its spec issue.
- **`extensions/<name>/README.md`:** what the extension does, its tools, commands, keys and `rig.json` settings, in short sections.

Update both READMEs in the same change that adds or changes an extension.
