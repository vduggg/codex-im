# Feishu File Bridge Design

## Summary

Add bidirectional file handling for the existing Feishu bot bridge:

- Keep the current outbound path from local workspace to Feishu via `/codex send <relative-path>`.
- Add inbound file handling from Feishu to the current bound workspace.
- Store inbound files under `<workspaceRoot>/.codex-im/inbox/`.
- Forward a text prompt to Codex that references the saved file path, so Codex can open the file from the workspace directly.

This avoids introducing a new Codex RPC attachment type and stays compatible with the current input model, which only supports text and local images.

## Goals

- Support Feishu user -> bot file uploads in the current conversation flow.
- Preserve current local -> Feishu file sending behavior.
- Keep the implementation compatible with the existing Codex RPC transport.
- Make saved files available in the bound workspace for follow-up turns.
- Fail safely when there is no bound workspace, download fails, or the file cannot be saved.

## Non-Goals

- No new generic file attachment format in the Codex RPC payload.
- No automatic cleanup policy for saved inbound files in this change.
- No group-chat specific behavior. This change follows the current single-chat binding model.

## Current Constraints

- `src/infra/codex/user-input.js` only builds `text` and `localImage` input items.
- `src/domain/workspace/workspace-service.js` already supports outbound file sending to Feishu with `/codex send`.
- `src/infra/feishu/client-adapter.js` already supports uploading files to Feishu and downloading image resources.
- `src/presentation/message/normalizers.js` currently only normalizes `text`, `image`, and `post` messages.

## Chosen Approach

When a Feishu file message arrives:

1. Normalize the incoming message into a `files` array that contains Feishu file metadata.
2. Resolve the active bound workspace as usual.
3. Download each file from Feishu and save it under `<workspaceRoot>/.codex-im/inbox/`.
4. Build a synthetic text prompt that references the saved relative paths.
5. Send that text prompt to Codex using the existing text input path.

Example generated prompt for a file-only message:

```text
用户上传了 1 个文件，请先读取它们，再继续回答：
- .codex-im/inbox/20260507T120000Z-build-log.txt
```

Example generated prompt for a message that already contains text:

```text
帮我看下这个日志为什么启动失败

用户还上传了 1 个文件，请先读取它们，再继续回答：
- .codex-im/inbox/20260507T120000Z-build-log.txt
```

## Message Normalization Changes

Extend the normalized message shape with:

```js
files: [
  {
    fileKey: "file_v3_xxx",
    fileName: "build-log.txt",
    sourceType: "file",
  },
]
```

Rules:

- `text` message:
  - `text` set from message content
  - `images` empty
  - `files` empty
- `image` message:
  - current behavior unchanged
- `post` message:
  - current text + image behavior unchanged
  - `files` empty for now
- `file` message:
  - `text` empty
  - `images` empty
  - `files` populated from `file_key` and `file_name`
  - `messageType` set to `file_only`

This design deliberately avoids inventing mixed `post + file` parsing until a real Feishu payload requires it.

## File Download And Storage

Add a dedicated file resource service parallel to the existing image resource service.

Responsibilities:

- Ensure `<workspaceRoot>/.codex-im/inbox/` exists.
- Sanitize the source file name.
- Prefix the saved name with a UTC timestamp to avoid collisions.
- Save files only inside the inbox directory.
- Return both absolute and workspace-relative paths.
- Remove partially written files if a later file in the same batch fails.

Saved path format:

```text
<workspaceRoot>/.codex-im/inbox/YYYYMMDDTHHMMSSZ-<sanitized-name>
```

If the original file name is missing, use `file`.

## Feishu Adapter Changes

Add a general file download method alongside `downloadImageByKey`.

New adapter API:

```js
downloadFileByKey({ messageId, fileKey })
```

Behavior:

- Call the Feishu message resource API with `type: "file"`.
- Reuse the existing binary extraction helpers.
- Return `{ buffer, mimeType }`.
- Reject empty buffers.

## Thread Send Flow Changes

Before `runtime.codex.sendUserMessage(...)`:

- Download image inputs as today.
- Download file inputs into workspace inbox when `normalized.files.length > 0`.
- Build the final text sent to Codex from:
  - original `normalized.text`
  - appended file notice block if files were saved

The file notice block uses workspace-relative paths so Codex sees stable project-local paths instead of host-specific absolute paths.

## Error Handling

- No bound workspace:
  - keep existing behavior and ask the user to bind first
- File resource download failure:
  - send a Feishu info card with the failure reason
  - do not send a partial prompt to Codex
- Save failure:
  - same as above
- Empty or malformed file metadata:
  - ignore the message during normalization
- Partial multi-file failure:
  - remove any earlier files saved during the same message
  - fail the whole inbound file batch

## Security And Safety

- Never trust `file_name` as a path. Use basename-like sanitization only.
- Never let inbound files escape `<workspaceRoot>/.codex-im/inbox/`.
- Keep current workspace binding checks unchanged.
- Do not auto-execute or auto-open saved files in the bridge.

## Testing Strategy

- Extend `test/message-normalizers.test.js` with file-message coverage.
- Extend `test/feishu-client-adapter.test.js` with file resource download coverage.
- Add `test/feishu-file-resource-service.test.js` for inbox save, sanitization, and rollback behavior.
- Add `test/thread-service-file-input.test.js` for final Codex prompt construction and inbox save integration.
- Re-run existing image-input tests to ensure no regression in mixed media handling.

## Files Expected To Change

- Modify `src/presentation/message/normalizers.js`
- Modify `src/app/dispatcher.js`
- Modify `src/domain/thread/thread-service.js`
- Modify `src/app/feishu-bot-runtime.js`
- Modify `src/infra/feishu/client-adapter.js`
- Create `src/infra/feishu/file-resource-service.js`
- Modify `README.md`
- Modify `docs/feishu-setup.md` if a new Feishu permission string is needed after implementation verification
- Modify or create related tests under `test/`

## Open Decision Closed By Design

Inbound Feishu files will be persisted in the bound project and surfaced to Codex as text-visible workspace-relative paths. This is the selected design because it is compatible with the current Codex RPC surface and preserves useful file state across turns.
