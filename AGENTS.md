# AGENTS.md

This repository is the private runtime version of the Codex-to-Feishu bridge on this machine.

## Boundary

This private branch may contain local workflow code, local paths, and personal automation integrations. It must not be treated as a public release branch.

Do not commit:

- `.env` or any real token/secret.
- `node_modules/`.
- `logs/` or runtime output.
- Python bytecode, generated archives, or temporary backup files.

## Branch Rule

Keep private runtime work on `private/*` branches. Do not push private branches to a public upstream unless Jiao explicitly approves the exact destination and scope.

The public shareable core lives separately at:

```text
/Users/keeploving/codex/codex-feishu-bridge-plugin
```

## Validation

Before committing runtime code changes, run:

```sh
npm run check
```

If a change touches startup, Feishu callbacks, approval cards, memory recall, or command routing, also verify the running bridge behavior from Feishu or local logs.
