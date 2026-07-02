# Task 07 — Real ClaudeAgentEngine (M2 / Phase 2a) — ✅ DONE

Date: 2026-07-03. Milestone [M2](../milestones/M2-real-engine.md).

The plan-review U1 fix played out: the "0A/0B gate" that had blocked two phases was runnable on
THIS machine, and it passed on the first attempt.

## S2.1 — 0B research (engine mechanism locked)

Verified via the `claude-api` skill and the SDK's own export surface (`Object.keys` on
`@anthropic-ai/claude-agent-sdk`): the licensed path for driving Claude Code from a subscription
user's own machine is the **Claude Agent SDK** (`query()` in streaming-input mode), which spawns the
locally-installed `claude` CLI and inherits its auth. **No `ANTHROPIC_API_KEY` required.**

Key SDK surface confirmed against the docs (via WebFetch of code.claude.com/docs/en/agent-sdk):

| Need                              | SDK primitive                                                 |
|-----------------------------------|---------------------------------------------------------------|
| Long-lived interactive session    | `query({ prompt: AsyncIterable<SDKUserMessage>, options })`   |
| Tool approval callback            | `options.canUseTool: (name, input, {toolUseID, signal})`      |
| Interrupt in-flight turn          | `query.interrupt()` (streaming-input mode only)               |
| Native session resume             | `options.resume: <sessionId>` on a fresh `query()`            |
| Session identity                  | first system/init message → `session_id`                      |
| Assistant deltas                  | `stream_event.content_block_delta.text_delta`                 |
| Assistant/tool blocks             | `assistant.message.content[]` (text / tool_use blocks)        |
| Tool results                      | `user.message.content[]` (tool_result blocks)                 |
| Turn boundary                     | `result` message (`subtype: "success" \| "error_..."`)        |

## S2.2 — 0A runtime spike [GATE] — PASS

`packages/daemon/spike/agent-spike.mjs` on `claude-haiku-4-5`, live on this machine:

```
L1 file-written:      true    (canUseTool → allow → real greeting.txt on disk)
L2 multi-turn:        true    (second prompt in same live query got a coherent result)
L3 interrupt:         true    (interrupt() during a long-turn returned control)
L4 context-preserved: true    (fresh query with resume=sessionId recalled "greeting.txt")
permission calls:     1
GATE PASS ✅
```

The critical finding for the daemon mapping: **after `interrupt()` the SDK still emits a `result`
message for the interrupted turn** (`subtype: "error_during_execution"`) — it does NOT close the
stream. The `ClaudeAgentEngine` uses an `interrupted` flag to remap the *next* `result` to
`turn_complete { status: "interrupted" }`, matching the MockEngine contract.

## S2.3 — `ClaudeAgentEngine` implementation

`packages/daemon/src/engine/ClaudeAgentEngine.ts` implements `IAgentEngine` behind the same seam as
`MockEngine`. Design highlights:

- **Injectable SDK `queryFn`** — production defaults to a lazy `import()` of
  `@anthropic-ai/claude-agent-sdk`; tests inject a scripted fake so the unit path never touches the
  real SDK or the CLI subprocess.
- **`InputChannel`** — an async-iterable queue that lets us keep the `query()` running across many
  turns while pushing user messages on demand (the SDK's streaming-input mode).
- **`canUseTool` bridge** — invokes `onPermissionRequest(...)` with the SDK's `toolUseID` as our
  `requestId`; resolves once the daemon's `approveTool`/`denyTool` fires. Auto-generates a diff
  preview for `Write` / `Edit` tool inputs (`diffPath` + unified `diffUnified`).
- **Message mapping** —
  - `system/init.session_id` → `ConversationCheckpoint`
  - `stream_event.content_block_delta.text_delta` → `assistant_delta`
  - `assistant.message.content[text]` → `assistant_message`
  - `assistant.message.content[tool_use]` → `tool_use`
  - `user.message.content[tool_result]` → `tool_stream` + `tool_result` (with `ok = !is_error`)
  - `result` → `turn_complete { status: interrupted | ok | error }`
- **`resumeConversation(checkpoint)`** closes the current input channel and starts a fresh
  `query({ resume: checkpointId })` — the same shape the 0A spike proved.

Daemon wiring: `packages/daemon/src/index.ts` now accepts `WCC_ENGINE=claude` (previously exited 2);
optional `WCC_MODEL` chooses the model, otherwise the CLI's default applies.

## Tests

- `packages/daemon/test/ClaudeAgentEngine.test.ts` — 9 tests: session_id capture; delta/final
  mapping; canUseTool → allow with `updatedInput`; canUseTool → deny; tool_use/tool_result mapping;
  result → ok/error/interrupted; `interrupt()` denies pending + remaps next result; `send()` pushes
  to the input channel; `resumeConversation()` restarts with `resume=…`.
- Full suite: **132/132** across 16 files (was 123). Typecheck clean.

## Live re-run recipe

```
# 1. Point the daemon at Claude and a workspace
WCC_ENGINE=claude \
WCC_RELAY_URL=ws://localhost:8787 \
WCC_RELAY_TOKEN=dev-relay-token \
WCC_DEVICE_ID=dev-device \
WCC_SESSION_ID=dev-session \
WCC_WORKSPACE_ROOT=E:/StorageContent/tmp/preview-ws \
WCC_PAIRED_PUBKEY=<browser pubkey> \
node dist/daemon.mjs

# 2. Start relay + Vite as in task-05, drive from the browser.
```

## What did NOT change

- `IAgentEngine` — the seam held. Session/Daemon/Storage/Web are untouched.
- The MockEngine — still used by every test and the Phase 0 demo path.
- Auth model — the real engine uses the machine's local Claude Code login; no API key path.

## Next

**Phase 2b** (per amended PLAN.md §Phases): payload E2E encryption (required before public
launch — X25519 in pairing, see ISSUES #15), WebAuthn passkeys, revoke/kill-switch, hardened CSP,
daemon packaging. Owner dogfood on the real engine happens in parallel.
