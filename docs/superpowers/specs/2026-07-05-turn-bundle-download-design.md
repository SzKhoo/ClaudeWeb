# Turn-bundle download — design

**Date:** 2026-07-05
**Scope:** P1 (personal, LAN)
**Depends on:** existing `file_request` / `file_data` protocol + Session.serveFileRequest sandboxing

## Problem

WebClaudeCode is the user's daily driver for personal work done on a phone (personal laptop is not allowed at their MNC). When Claude Code writes or edits a file in the workspace, the user needs the resulting file back on their phone so they can carry it elsewhere (e.g. diff against the real DLL in the example that motivated this).

The current UX is per-file: every Write/Edit/Read tool card in the transcript shows a `⬇` button that fires a `file_request` and downloads a single file. That works, but when a turn changes several files the user has to tap N times, each producing a separate "save file?" prompt on mobile — enough friction that they end up not doing it.

## Solution

After each turn that changed one or more files, show a single chip in the transcript:

> `⬇ Download N files changed this turn (zip)`

Tapping it produces one zip download (`changes-<HHMMSS>.zip`) containing every file the turn wrote or edited.

The existing per-tool `⬇` stays as-is — this is additive, aimed at the common "grab everything from that turn" case.

## Non-goals

- No per-file selection inside the zip. All-or-nothing per turn.
- No cross-turn "download every file I changed this session" bundle. One turn, one chip.
- No zip preview before download.
- No streaming zip. The daemon builds it fully in memory and sends one payload — same shape as `file_data`.
- No change to the existing per-tool `⬇`.

## What counts as "changed this turn"

A file is included in the turn's bundle iff:

1. A tool call in this turn had `name ∈ { Write, Edit, MultiEdit, NotebookEdit }`, and
2. The tool's input had a workspace-relative path field (`file_path`, `path`, or `notebook_path`) — the same extraction the transcript already does in `toolPath`, and
3. The daemon reported a matching `tool_result` with `ok === true`.

Files touched by `Read` (or any other tool) do not count — nothing about them changed. Duplicate paths across multiple tool calls in the same turn collapse to one entry.

## Data flow

```
web (per turn):
  tool_use(Write/Edit/…) + matching ok tool_result
      → SessionModel.filesChangedThisTurn.add(path)
  turn_complete
      → snapshot the set onto the turn's transcript item, clear the live set
      → render <BundleChip paths=... /> in the transcript
  next user_message send
      → (already snapshotted; no further work)

user taps chip:
  web → daemon:  { type: "bundle_request", requestId, paths: string[] }
  daemon → web:  { type: "file_data", requestId, name: "changes-….zip",
                   mediaType: "application/zip", data | error | truncated }
  web: existing handleFileData → downloadBase64 → phone save prompt
```

## Protocol changes

`packages/shared/src/protocol/messages.ts`:

```ts
export interface CmdBundleRequest {
  type: "bundle_request";
  /** Correlates the reply file_data event back to this request. */
  requestId: string;
  /** Workspace-relative paths. Same sandboxing rules as file_request:
      absolute paths and `..` traversal are rejected per path. */
  paths: string[];
}
```

- Added to `ApplicationCommand` union.
- Added to `COMMAND_TYPES` set (must be signature-verified — invariant #2/#4).
- **Reply reuses `EvtFileData`.** `name` = the zip filename, `mediaType` = `application/zip`, `path` = the zip name (there is no single source path). No new event type is introduced.

The web handler for `file_data` already treats `mediaType` opaquely (`downloadBase64(name, mediaType, data)`), so it does not need to distinguish single-file from bundle replies.

## Daemon changes

`packages/daemon/src/session/Session.ts`:

- Dispatch new command type in the command switch, alongside `file_request`.
- Add `serveBundleRequest(clientInstanceId, requestId, paths)`:
  - Per-path: reuse `safeResolve` (already handles workspace-root resolution + rejects absolute paths and `..` traversal). A path that fails validation or fails to read is skipped and recorded in a summary; a request where **every** path fails replies with `error`.
  - Read each valid file's bytes.
  - Build a zip in memory using `jszip` (pure JS, ~100KB, no native deps — already fine for the daemon's node target).
  - Enforce `MAX_FILE_BYTES` against the accumulated payload (raw bytes, before base64). If adding the next file would exceed the cap, stop, mark `truncated: true`, and send what fits.
  - Reply targeted (out-of-band, seq 0) to `clientInstanceId` with a `file_data` event: `name = "changes-<HHMMSS>.zip"`, `mediaType = "application/zip"`, `data = base64(zipBytes)`.
  - Empty result (all paths invalid, or zero paths): reply with `error: "No files were readable."`.

Dep add: `jszip` in `packages/daemon/package.json`.

## Web changes

**`packages/web/src/session-model.ts`**
- Add `filesChangedThisTurn: Set<string>` (live, not part of the view).
- On `tool_use` for Write/Edit/MultiEdit/NotebookEdit with a path: remember the toolId → path mapping.
- On `tool_result` with `ok: true`: if we have a remembered path for that toolId, add it to the live set.
- On `turn_complete`: attach a snapshot (`changedFiles: string[]`) to the turn's terminal transcript item (a new `kind: "turn"` item, or an existing marker — smallest change is to add a small `kind: "bundle"` transcript item when the set is non-empty). Clear the live set + toolId→path map.
- The snapshot lives in the transcript so it survives subsequent turns.

**`packages/web/src/ui/Transcript.tsx`**
- Handle new item kind and render a `<BundleChip>` when a turn produced changes.
- Chip label: `⬇ Download N file{s} changed this turn (zip)` where N ≥ 1.
- On click: call new prop `onDownloadBundle(paths: string[])`.

**`packages/web/src/App.tsx` + `Phase1Shell.tsx`**
- Add `requestBundle(paths)` alongside the existing `requestFile(path)`; sends `bundle_request` with a fresh `requestId`.
- Pass it to `<Transcript />`.
- `handleFileData` is unchanged — bundle replies flow through it, `downloadBase64` handles `application/zip` fine, and it already shows a "Downloaded X (truncated…)" system message when `truncated` is set.

**Styling** (`packages/web/src/styles.css`)
- One small `.bundle-chip` rule. Follows the existing `.tool-download` / system-message look.

## Security

- Every path in a `bundle_request` is re-validated by the daemon on receipt via `safeResolve` — the browser is not trusted to send safe paths. Same guarantees as `file_request` (workspace root, no `..`, no absolute). Symlink-escape hardening is out of scope for this change — it isn't done for `file_request` today either, and adding it here would create a divergent bar.
- Size cap is enforced against the accumulated raw payload, not per file. The existing `MAX_FILE_BYTES` value applies.
- The command is signed like every other command (invariant #2/#4) — no new authorization surface.

## Testing

- **`packages/shared/test/messages.test.ts`** — `bundle_request` is in `COMMAND_TYPES`; `requiresSignature("bundle_request") === true`; round-trip encode/decode.
- **`packages/daemon/test/Session.test.ts`**
  - happy path: 2 valid paths → zip contains both entries with correct bytes, replied targeted with `mediaType: application/zip`.
  - path traversal / absolute path rejected per-path; other paths still included.
  - all-invalid → error reply.
  - cap enforcement: total payload > `MAX_FILE_TRANSFER_BYTES` → `truncated: true`, partial zip.
- **Web** — SessionModel unit test: sequence of `tool_use` (Write) + ok `tool_result` + `turn_complete` produces a bundle item with the expected paths; failed `tool_result` (ok: false) is not included; Read is not included; duplicate paths collapse.

## Rollout

Single PR to `main` after merge to `p1-local-phone`. No feature flag — the chip is only shown when a turn changed files, so it's invisible until the first Write/Edit turn happens.

## Open questions

None — user confirmed one-zip-per-turn UX.
