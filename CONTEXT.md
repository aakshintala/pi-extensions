# pi-rig

This context covers locally owned Pi extensions and the controls used to keep their runtime surface small, observable, and reviewable.

## Language

**Rig**:
This package: the user's own set of locally rebuilt Pi extensions, loaded as one package. Its command is `/rig` and its settings file is `~/.pi/agent/rig.json`. _Avoid_: pack, extension pack

**Extension package**:
A locally rebuilt collection of Pi customizations that the installation loads as its owned runtime. _Avoid_: plugin bundle, third-party package

**Runtime surface**:
The externally visible tools, commands, skills, providers, models, and lifecycle behavior contributed by the extension package. _Avoid_: feature list

**Runtime audit**:
A check that loads the extension package through Pi's integration boundary and records its observable runtime surface, prompt cost, and cleanup behavior. _Avoid_: static inspection

**Prompt budget**:
The allowed context cost of active model-facing tool definitions and guidance. _Avoid_: token quota

**Merge gate**:
The CI result that must pass before a change can merge into the main branch. _Avoid_: advisory check

**Upstream source**:
Third-party implementation retained for provenance and audit but not executed by Pi. _Avoid_: vendored runtime
