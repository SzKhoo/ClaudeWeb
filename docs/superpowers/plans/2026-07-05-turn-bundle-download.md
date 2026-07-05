# Turn-bundle download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a turn changes files, show a chip in the transcript that downloads a single zip of those files to the phone.

**Architecture:** New signed command `bundle_request { paths[] }` handled by the daemon; it reuses the existing `safeResolve` sandboxing and the existing `file_data` event shape for the reply (with `mediaType: application/zip`). The web `SessionModel` tracks files touched by Write/Edit/MultiEdit/NotebookEdit inside each turn and emits a `bundle` transcript item on `turn_complete`. The `Transcript` renders it as a chip that fires the new command.

**Tech Stack:** TypeScript, React 19, vitest. New runtime dep: `jszip` (pure JS, no native deps) in the root `node_modules` (this repo uses a flat root `node_modules` — see the root `package.json` comment; do NOT create `packages/daemon/package.json`).

## Global Constraints

- Root `node_modules` only. All deps live in the root `package.json`; the exFAT drive cannot handle npm/pnpm workspaces (root `package.json` comment).
- Cross-package imports use the `@wcc/shared` alias resolved by tsconfig paths / vitest / esbuild / vite.
- Every client → daemon command MUST be signature-verified (invariant #2/#4). New commands go in `COMMAND_TYPES`.
- Events are NEVER signed (invariant). The reply reuses `EvtFileData`.
- Reply is targeted (`to: clientInstanceId`) and out-of-band (`seq: 0`) — download side-channel, not part of the transcript.
- Cap: `MAX_FILE_BYTES` = 10 MiB, applied against the accumulated **raw** payload before base64.
- Zip filename format: `changes-HHMMSS.zip` (local time; sortable enough for the user's use case).
- TDD: every task writes a failing test first, then the minimal code to pass, then commits.

---

## File Structure

**Create:**
- `docs/superpowers/plans/2026-07-05-turn-bundle-download.md` — this plan (already at this path).

**Modify:**
- `packages/shared/src/protocol/messages.ts` — add `CmdBundleRequest`, add to `ApplicationCommand` union + `COMMAND_TYPES`.
- `packages/shared/test/messages.test.ts` — add tests for `bundle_request` classification.
- `packages/daemon/src/session/Session.ts` — dispatch `bundle_request`, add `serveBundleRequest`.
- `packages/daemon/test/Session.test.ts` — add tests for the new handler.
- `packages/web/src/session-model.ts` — add `TranscriptItem` variant `bundle`, track filesChangedThisTurn, emit on `turn_complete`.
- `packages/web/test/session-model.test.ts` — add tests for the tracking + emission.
- `packages/web/src/ui/Transcript.tsx` — accept `onDownloadBundle` prop, render the chip.
- `packages/web/src/App.tsx` — wire `requestBundle`, pass to `Transcript`.
- `packages/web/src/Phase1Shell.tsx` — same wiring in the phase 1 shell.
- `packages/web/src/styles.css` — `.bundle-chip` style.
- `package.json` (root) — add `jszip` under `dependencies`.

---

## Task 1: Protocol — add `bundle_request`

**Files:**
- Modify: `packages/shared/src/protocol/messages.ts`
- Test: `packages/shared/test/messages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CmdBundleRequest { type: "bundle_request"; requestId: string; paths: string[] }`
  - `"bundle_request"` in the `ApplicationCommand` union and `COMMAND_TYPES` set.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/messages.test.ts`:

```ts
import type { CmdBundleRequest } from "../src/index.js";

// … inside the existing describe block …
  it("treats bundle_request as a command that must be signed", () => {
    const cmd: CmdBundleRequest = {
      type: "bundle_request",
      requestId: "b1",
      paths: ["src/a.ts", "src/b.ts"],
    };
    expect(isCommand(cmd)).toBe(true);
    expect(isEvent(cmd)).toBe(false);
    expect(requiresSignature("bundle_request")).toBe(true);
  });
```

Also extend the top-level `import { … type CmdFileRequest, type CmdUserMessage, type EvtFileData, } from "../src/index.js";` to include `type CmdBundleRequest`.

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run packages/shared/test/messages.test.ts
```

Expected: FAIL with a type/export error on `CmdBundleRequest`.

- [ ] **Step 3: Add the type**

In `packages/shared/src/protocol/messages.ts`, immediately after the `CmdFileRequest` interface (around line 126):

```ts
/**
 * Ask the daemon to send back a single zip containing the given workspace files (the "download all
 * files changed this turn" chip in the transcript). Each path is workspace-relative and sandboxed the
 * same way as file_request. The reply reuses `file_data` with `mediaType: "application/zip"`.
 */
export interface CmdBundleRequest {
  type: "bundle_request";
  /** Correlates the reply `file_data` event back to this request. */
  requestId: string;
  /** Workspace-relative paths. Absolute paths / `..` traversal are rejected per-path by the daemon. */
  paths: string[];
}
```

In the `ApplicationCommand` union (search for `| CmdFileRequest`), add on the next line:

```ts
  | CmdBundleRequest
```

In the `COMMAND_TYPES` set literal (search for `"file_request",`), add on the next line:

```ts
  "bundle_request",
```

Verify `packages/shared/src/index.ts` re-exports it (it re-exports the whole `messages` module — no edit needed if that's the case; if it exports named symbols, add `CmdBundleRequest` alongside `CmdFileRequest`).

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run packages/shared/test/messages.test.ts
npx tsc -p tsconfig.json
```

Expected: PASS + no type errors.

- [ ] **Step 5: Commit**

```
git add packages/shared/src/protocol/messages.ts packages/shared/test/messages.test.ts
git commit -m "protocol: add bundle_request command (reuses file_data reply)"
```

---

## Task 2: Daemon — `serveBundleRequest`

**Files:**
- Modify: `packages/daemon/src/session/Session.ts`
- Modify: `package.json` (root — add `jszip`)
- Test: `packages/daemon/test/Session.test.ts`

**Interfaces:**
- Consumes: `CmdBundleRequest` (Task 1). `safeResolve(p: string): string | undefined` (existing in Session.ts).
- Produces:
  - `Session` now handles `case "bundle_request":` in `handleCommand`.
  - Private method `serveBundleRequest(clientInstanceId: string, requestId: string, paths: string[]): Promise<void>` that emits ONE `file_data` event to `clientInstanceId` with `mediaType: "application/zip"`, `name: changes-HHMMSS.zip`, `path` = the zip name.

- [ ] **Step 1: Install `jszip`**

```
npm install jszip
```

Verify `jszip` appears under `dependencies` in the root `package.json` and in `node_modules/jszip`.

- [ ] **Step 2: Write the failing happy-path test**

Append inside the existing `describe(...)` block in `packages/daemon/test/Session.test.ts`, after the last file_request test:

```ts
  it("serves a bundle_request by zipping the requested workspace files", async () => {
    const h = makeHarness(root);
    await h.session.start();
    writeFileSync(join(root, "a.txt"), "hello a", "utf8");
    writeFileSync(join(root, "b.txt"), "hello b", "utf8");

    await h.session.handleCommand(
      { type: "bundle_request", requestId: "bd-1", paths: ["a.txt", "b.txt"] },
      CLIENT,
    );

    const data = h.out.find((o) => o.to === CLIENT && o.event.type === "file_data");
    expect(data).toBeDefined();
    const evt = data!.event as EvtFileData;
    expect(evt.requestId).toBe("bd-1");
    expect(evt.mediaType).toBe("application/zip");
    expect(evt.name).toMatch(/^changes-\d{6}\.zip$/);
    expect(evt.error).toBeUndefined();
    expect(evt.data).toBeTruthy();

    // Decode the zip and check both entries.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(Buffer.from(evt.data!, "base64"));
    expect(await zip.file("a.txt")!.async("string")).toBe("hello a");
    expect(await zip.file("b.txt")!.async("string")).toBe("hello b");
  });

  it("rejects paths that escape the workspace root but still includes valid ones", async () => {
    const h = makeHarness(root);
    await h.session.start();
    writeFileSync(join(root, "ok.txt"), "ok", "utf8");

    await h.session.handleCommand(
      { type: "bundle_request", requestId: "bd-2", paths: ["../../secret.txt", "ok.txt"] },
      CLIENT,
    );

    const data = h.out.find((o) => o.to === CLIENT && o.event.type === "file_data");
    const evt = data!.event as EvtFileData;
    expect(evt.error).toBeUndefined();
    expect(evt.data).toBeTruthy();
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(Buffer.from(evt.data!, "base64"));
    expect(zip.file("ok.txt")).toBeTruthy();
    expect(zip.file("../../secret.txt")).toBeNull();
  });

  it("returns an error bundle reply when every path is invalid or missing", async () => {
    const h = makeHarness(root);
    await h.session.start();

    await h.session.handleCommand(
      { type: "bundle_request", requestId: "bd-3", paths: ["../oops", "not-there.txt"] },
      CLIENT,
    );

    const data = h.out.find((o) => o.to === CLIENT && o.event.type === "file_data");
    const evt = data!.event as EvtFileData;
    expect(evt.data).toBeUndefined();
    expect(evt.error).toBeTruthy();
  });

  it("truncates the bundle when the accumulated raw bytes exceed MAX_FILE_BYTES", async () => {
    const h = makeHarness(root);
    await h.session.start();
    // MAX_FILE_BYTES = 10 MiB. Two 6-MiB files → second one must be dropped and truncated=true.
    const big = "x".repeat(6 * 1024 * 1024);
    writeFileSync(join(root, "big1.txt"), big, "utf8");
    writeFileSync(join(root, "big2.txt"), big, "utf8");

    await h.session.handleCommand(
      { type: "bundle_request", requestId: "bd-4", paths: ["big1.txt", "big2.txt"] },
      CLIENT,
    );

    const data = h.out.find((o) => o.to === CLIENT && o.event.type === "file_data");
    const evt = data!.event as EvtFileData;
    expect(evt.truncated).toBe(true);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(Buffer.from(evt.data!, "base64"));
    expect(zip.file("big1.txt")).toBeTruthy();
    expect(zip.file("big2.txt")).toBeNull();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

```
npx vitest run packages/daemon/test/Session.test.ts
```

Expected: 4 new tests FAIL because the daemon doesn't handle `bundle_request` yet (unknown command / no `file_data` reply).

- [ ] **Step 4: Implement dispatch + serveBundleRequest**

In `packages/daemon/src/session/Session.ts`:

Add near the top with the other imports:

```ts
import JSZip from "jszip";
```

In `handleCommand`, immediately after the `case "file_request":` block (around line 128), add:

```ts
      case "bundle_request":
        await this.serveBundleRequest(clientInstanceId, command.requestId, command.paths);
        return;
```

Add the private method next to `serveFileRequest` (around line 388, just before `safeResolve`):

```ts
  /**
   * Serve a bundle_request: read each workspace-relative path, zip them, and reply with one file_data
   * event carrying `application/zip`. Paths that escape the workspace root or fail to read are skipped;
   * if every path fails, reply with an error. The accumulated raw bytes are capped at MAX_FILE_BYTES —
   * if adding the next file would exceed it, stop and mark `truncated: true`.
   */
  private async serveBundleRequest(
    clientInstanceId: string,
    requestId: string,
    paths: string[],
  ): Promise<void> {
    const name = bundleName(this.now());
    const reply = (extra: Partial<EvtFileData>): void => {
      this.deliver({
        seq: 0,
        to: clientInstanceId,
        event: {
          type: "file_data",
          requestId,
          path: name,
          name,
          mediaType: "application/zip",
          ...extra,
        },
      });
    };

    const zip = new JSZip();
    let accumulated = 0;
    let truncated = false;
    let added = 0;

    for (const p of paths) {
      const abs = this.safeResolve(p);
      if (!abs) continue;
      let buf: Buffer;
      try {
        buf = await readFile(abs);
      } catch {
        continue;
      }
      if (accumulated + buf.length > MAX_FILE_BYTES) {
        truncated = true;
        break;
      }
      zip.file(p, buf);
      accumulated += buf.length;
      added += 1;
    }

    if (added === 0) {
      reply({ error: "No files could be bundled (all paths were invalid or unreadable)." });
      return;
    }

    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    reply({ data: bytes.toString("base64"), ...(truncated ? { truncated: true } : {}) });
  }
```

And add a small helper at the bottom of the file (or beside `guessMediaType` — keep it near the other file helpers):

```ts
function bundleName(nowMs: number): string {
  const d = new Date(nowMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `changes-${hh}${mm}${ss}.zip`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
npx vitest run packages/daemon/test/Session.test.ts
npx tsc -p tsconfig.json
```

Expected: all Session.test.ts tests PASS. No type errors.

- [ ] **Step 6: Commit**

```
git add package.json package-lock.json packages/daemon/src/session/Session.ts packages/daemon/test/Session.test.ts
git commit -m "daemon: serve bundle_request by zipping requested workspace files"
```

---

## Task 3: Web — track files changed per turn in `SessionModel`

**Files:**
- Modify: `packages/web/src/session-model.ts`
- Test: `packages/web/test/session-model.test.ts`

**Interfaces:**
- Consumes: `ApplicationEvent` (`tool_use`, `tool_result`, `turn_complete`, `user_message` locally).
- Produces:
  - New `TranscriptItem` variant: `{ kind: "bundle"; id: string; paths: string[] }`.
  - `SessionModel.apply` emits a `bundle` item on `turn_complete` (status `"ok"`) iff the turn wrote/edited ≥1 file.
  - Set clears on the next `addLocalUserMessage`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/test/session-model.test.ts`:

```ts
  it("emits a bundle transcript item on turn_complete for Write/Edit tools that succeeded", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("edit two files");
    m.apply({ type: "tool_use", toolId: "t1", name: "Write", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "t1", ok: true });
    m.apply({ type: "tool_use", toolId: "t2", name: "Edit", input: { file_path: "b.ts" } });
    m.apply({ type: "tool_result", toolId: "t2", ok: true });
    m.apply({ type: "turn_complete", status: "ok" });

    const list = items(m);
    const bundle = list.find((i) => i.kind === "bundle");
    expect(bundle).toBeDefined();
    expect((bundle as Extract<TranscriptItem, { kind: "bundle" }>).paths).toEqual(["a.txt", "b.ts"]);
  });

  it("does not emit a bundle for Read-only turns", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("read a file");
    m.apply({ type: "tool_use", toolId: "r1", name: "Read", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "r1", ok: true });
    m.apply({ type: "turn_complete", status: "ok" });

    expect(items(m).some((i) => i.kind === "bundle")).toBe(false);
  });

  it("excludes tool calls that failed and dedupes repeated paths", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("edit same file twice + one failure");
    m.apply({ type: "tool_use", toolId: "t1", name: "Edit", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "t1", ok: true });
    m.apply({ type: "tool_use", toolId: "t2", name: "Edit", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "t2", ok: true });
    m.apply({ type: "tool_use", toolId: "t3", name: "Write", input: { file_path: "b.txt" } });
    m.apply({ type: "tool_result", toolId: "t3", ok: false });
    m.apply({ type: "turn_complete", status: "ok" });

    const bundle = items(m).find((i) => i.kind === "bundle") as
      | Extract<TranscriptItem, { kind: "bundle" }>
      | undefined;
    expect(bundle).toBeDefined();
    expect(bundle!.paths).toEqual(["a.txt"]);
  });

  it("clears the changed-files tracker at the start of the next turn", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("turn 1");
    m.apply({ type: "tool_use", toolId: "t1", name: "Write", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "t1", ok: true });
    m.apply({ type: "turn_complete", status: "ok" });
    m.addLocalUserMessage("turn 2");
    m.apply({ type: "tool_use", toolId: "r1", name: "Read", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "r1", ok: true });
    m.apply({ type: "turn_complete", status: "ok" });

    const bundles = items(m).filter((i) => i.kind === "bundle");
    expect(bundles).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx vitest run packages/web/test/session-model.test.ts
```

Expected: 4 new tests FAIL — no `bundle` kind, no tracker.

- [ ] **Step 3: Extend the TranscriptItem union and SessionModel**

In `packages/web/src/session-model.ts`:

Extend the `TranscriptItem` union (around line 24) — add another variant:

```ts
  | { kind: "bundle"; id: string; paths: string[] }
```

Add these constants near the top of the file (below the imports):

```ts
const EDIT_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function extractToolPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const p = rec["file_path"] ?? rec["path"] ?? rec["notebook_path"];
  return typeof p === "string" ? p : undefined;
}
```

Add these instance fields on `SessionModel`, next to the other private fields (near line 68):

```ts
  private readonly pendingEdits = new Map<string, string>(); // toolId -> path (Write/Edit family only)
  private readonly changedThisTurn = new Set<string>();      // dedupes; iteration order = insertion
```

In `addLocalUserMessage` (near line 73), at the start of the method (before the existing push):

```ts
    this.pendingEdits.clear();
    this.changedThisTurn.clear();
```

In `apply` for `case "tool_use":`, after `this.items.push(...)`, before `return;`:

```ts
        if (EDIT_TOOL_NAMES.has(event.name)) {
          const p = extractToolPath(event.input);
          if (p) this.pendingEdits.set(event.toolId, p);
        }
```

In `apply` for `case "tool_result":`, after the existing `card.result = …;` line, before `return;`:

```ts
        const editPath = this.pendingEdits.get(event.toolId);
        if (editPath !== undefined) {
          this.pendingEdits.delete(event.toolId);
          if (event.ok) this.changedThisTurn.add(editPath);
        }
```

In `apply` for `case "turn_complete":`, immediately after `this.pending = undefined;`, insert:

```ts
        if (event.status === "ok" && this.changedThisTurn.size > 0) {
          this.items.push({
            kind: "bundle",
            id: this.nextId("b"),
            paths: Array.from(this.changedThisTurn),
          });
        }
        this.pendingEdits.clear();
        this.changedThisTurn.clear();
```

(The existing `if (event.status !== "ok") { … system message … }` block stays as-is right after.)

- [ ] **Step 4: Run tests to verify they pass**

```
npx vitest run packages/web/test/session-model.test.ts
npx tsc -p tsconfig.json && npx tsc -p packages/web/tsconfig.json
```

Expected: PASS + no type errors.

- [ ] **Step 5: Commit**

```
git add packages/web/src/session-model.ts packages/web/test/session-model.test.ts
git commit -m "web: track files changed per turn and emit a bundle transcript item"
```

---

## Task 4: Web UI — render the bundle chip and wire the download

**Files:**
- Modify: `packages/web/src/ui/Transcript.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/Phase1Shell.tsx`
- Modify: `packages/web/src/styles.css`

**Interfaces:**
- Consumes: `TranscriptItem` variant `bundle` (Task 3). `CmdBundleRequest` (Task 1). `handleFileData` (existing, no change).
- Produces:
  - `Transcript` prop `onDownloadBundle?: (paths: string[]) => void`.
  - `App` / `Phase1Shell` have a `requestBundle(paths: string[])` callback that sends `bundle_request` with a fresh `randomId()`.

- [ ] **Step 1: Extend `Transcript.tsx`**

At the top of `packages/web/src/ui/Transcript.tsx`, extend the props:

```ts
export function Transcript({
  items,
  onDownload,
  onDownloadBundle,
}: {
  items: TranscriptItem[];
  onDownload?: (path: string) => void;
  onDownloadBundle?: (paths: string[]) => void;
}) {
```

Pass it through in the `items.map`:

```ts
        <Item key={item.id} item={item} onDownload={onDownload} onDownloadBundle={onDownloadBundle} />
```

Extend `Item` signature:

```ts
function Item({
  item,
  onDownload,
  onDownloadBundle,
}: {
  item: TranscriptItem;
  onDownload?: (path: string) => void;
  onDownloadBundle?: (paths: string[]) => void;
}) {
```

Add a new `switch` arm in `Item` (right before the closing `}` of the switch):

```ts
    case "bundle":
      return (
        <div className="line bundle">
          <button
            className="bundle-chip"
            onClick={() => onDownloadBundle?.(item.paths)}
            title={item.paths.join("\n")}
          >
            ⬇ Download {item.paths.length} file{item.paths.length === 1 ? "" : "s"} changed this turn (zip)
          </button>
        </div>
      );
```

- [ ] **Step 2: Wire `requestBundle` in `App.tsx`**

In `packages/web/src/App.tsx`, right after the existing `requestFile` `useCallback` (around line 111):

```tsx
  const requestBundle = useCallback((paths: string[]) => {
    void connRef.current?.send({ type: "bundle_request", requestId: randomId(), paths });
  }, []);
```

Then find the JSX where `<Transcript … onDownload={requestFile} />` is rendered and add the prop:

```tsx
        <Transcript
          items={view.items}
          onDownload={requestFile}
          onDownloadBundle={requestBundle}
        />
```

- [ ] **Step 3: Wire `requestBundle` in `Phase1Shell.tsx`**

In `packages/web/src/Phase1Shell.tsx`, near where `<Transcript>` is rendered (there's an existing `void connRef.current?.send({ type: "file_request", … })` around line 290 — see the grep output for the exact line), add:

```tsx
  const requestBundle = useCallback((paths: string[]) => {
    void connRef.current?.send({ type: "bundle_request", requestId: randomId(), paths });
  }, []);
```

(Match the surrounding pattern — if the existing `requestFile`-equivalent isn't in a `useCallback`, put `requestBundle` in the same style right next to it.)

And in the `<Transcript … />` JSX, add:

```tsx
        onDownloadBundle={requestBundle}
```

- [ ] **Step 4: Style the chip**

Append to `packages/web/src/styles.css`:

```css
.line.bundle {
  display: flex;
  justify-content: flex-start;
  padding: 6px 12px;
}
.bundle-chip {
  background: var(--accent-bg, #1f6feb);
  color: var(--accent-fg, #fff);
  border: none;
  border-radius: 999px;
  padding: 8px 14px;
  font: inherit;
  font-size: 0.9em;
  cursor: pointer;
}
.bundle-chip:hover {
  filter: brightness(1.1);
}
```

(If the codebase already uses different accent-color variables, match them — look at existing button styles in the same file.)

- [ ] **Step 5: Typecheck + tests**

```
npx tsc -p tsconfig.json && npx tsc -p packages/web/tsconfig.json
npx vitest run
```

Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```
git add packages/web/src/ui/Transcript.tsx packages/web/src/App.tsx packages/web/src/Phase1Shell.tsx packages/web/src/styles.css
git commit -m "web: render bundle-download chip and wire bundle_request"
```

---

## Task 5: Manual end-to-end verify

**Files:**
- (No code changes — this is a smoke test that the feature works from a real browser against the local daemon.)

**Interfaces:**
- Consumes: full running stack (relay + daemon + web).

- [ ] **Step 1: Start the dev stack**

```
npm run dev:all
```

Wait for relay + daemon + web to be up (check the concatenated log output).

- [ ] **Step 2: Drive the golden path in a browser**

- Open the local web URL from the daemon logs.
- Ask Claude: `create three tiny text files a.txt b.txt c.txt with the words one two three`.
- Approve any permission prompts.
- After `turn_complete`, confirm a chip appears in the transcript reading `⬇ Download 3 files changed this turn (zip)`.
- Tap the chip.
- Confirm a `changes-HHMMSS.zip` downloads and, when opened, contains `a.txt`, `b.txt`, `c.txt` with the correct contents.

- [ ] **Step 3: Edge-case smoke**

- Ask Claude to `read a.txt` (Read-only turn). Confirm NO bundle chip appears.
- Ask Claude to `edit a.txt to say uno`. Confirm a bundle chip appears with just `a.txt`.

- [ ] **Step 4: If any manual verify failed, capture and fix**

Note what broke, then loop back to the relevant task (protocol/daemon/web) and add a regression test that captures the failure before fixing.

- [ ] **Step 5: Final commit (only if there were fixes)**

```
git add -A
git commit -m "fix: address issues found during turn-bundle E2E verify"
```

If manual verify passed with no code changes: skip this step.

---

## Self-Review Notes

Ran the self-review checklist against the spec:

1. **Spec coverage** — every spec section maps to a task:
   - Problem / trigger UX → Task 3 (bundle item on turn_complete) + Task 4 (chip render + wire).
   - "What counts as changed" → Task 3 (`EDIT_TOOL_NAMES`, ok result gate, dedupe).
   - Data flow → Tasks 3 → 4 → 2.
   - Protocol changes → Task 1.
   - Daemon changes → Task 2 (dispatch + serveBundleRequest + safeResolve reuse + jszip dep + cap).
   - Web changes → Tasks 3 (SessionModel), 4 (Transcript/App/Phase1Shell/styles).
   - Security → Task 2 (per-path `safeResolve`, signed command via Task 1 `COMMAND_TYPES`).
   - Testing → Task 1 (protocol), Task 2 (daemon), Task 3 (web unit), Task 5 (manual E2E).
2. **Placeholder scan** — every code step contains complete code; no "similar to task N", no "handle edge cases".
3. **Type consistency** — `CmdBundleRequest` shape identical across Task 1 (definition), Task 2 (daemon dispatch), Task 4 (web send). `bundle` transcript item shape identical across Task 3 (emission) and Task 4 (render). `paths: string[]` throughout.
