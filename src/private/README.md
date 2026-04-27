# Yuan Private Layer

This directory contains private extensions for the local `yuan-feishu` runtime.

The public bridge core should stay in these directories:

- `src/app`
- `src/domain`
- `src/infra`
- `src/presentation`
- `src/shared`

Private integrations live here:

- `extensions/memory-bridge`: Jiao Knowledge Wiki, TaskNotes, daily bridge, recall, and memory preflight.
- `extensions/hub`: local OpenClaw / Hermes / project-hub orchestration.
- `extensions/codex-profile-adapter.js`: local model/profile adapters that depend on private runtime config.

New private features should be added under `src/private` unless they are generic Feishu-Codex bridge behavior that also belongs in the public `codex-feishu-bridge` base.
