# Session-history sidebar — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the WebClaudeCode daemon multiple named sessions, a phone-friendly sidebar to list/open/rename/delete them, zero-cost read-only browsing of past transcripts, and cheap resume via an LLM-generated auto-summary injected as a hidden system prompt.

**Architecture:** Each session gets its own on-disk folder (`<workspace>/.wcc/sessions/<id>/{journal.jsonl, meta.json}`) plus a workspace-level `active.json` pointer. A new `SessionManager` inside the daemon owns switching between them (mutex-serialized). The daemon remains single-session at any instant; multi-session lives in the folder-per-id storage and a `SessionIndex` that scans `meta.json` files. Resume prepends a stored summary to the next engine turn as a one-shot system message.

**Tech Stack:** TypeScript (Node.js daemon + React web), vitest tests, Claude Agent SDK, existing JournalSink/SessionStorage/Session shape.

**Spec:** [docs/superpowers/specs/2026-07-06-session-history-sidebar-design.md](../specs/2026-07-06-session-history-sidebar-design.md)

## Global Constraints

- **Language:** TypeScript strict mode. All new files `.ts`/`.tsx`. Node ≥ 20 (already required).
- **Test framework:** vitest. New tests live under `packages/<pkg>/test/*.test.ts`.
- **Journal format:** existing `JournalRecord` shape (event / turn_start / turn_end). New in-journal event type = an `ApplicationEvent` variant; no new `JournalRecord` kind.
- **Session id:** ULID (26 chars, lexicographically time-sortable). Add `ulid` npm dep if not present.
- **Paths:** all sessions live under `<workspace>/.wcc/sessions/<id>/`. Existing daemon comment (`packages/daemon/src/storage/journal.ts:4`) already predicts this layout — we're formalizing it.
- **Protocol:** commands and events extend the tagged unions in `packages/shared/src/protocol/messages.ts`. Any new command must be added to `ApplicationCommand` union AND `COMMAND_TYPES` set at line ~319. Any new event must be added to `ApplicationEvent` union.
- **Injection at Daemon boundary:** the Daemon already receives dependencies from its caller (`opts.journal`, engine, etc.). We refactor to receive a `sessionsRoot: string` and lose the direct `journal` opt; the `SessionManager` internally opens/closes `FileJournal`s.
- **Commit style:** conventional prefixes (`feat:`, `refactor:`, `test:`, `docs:`); one commit per task minimum, more if a task naturally splits.

---

## File plan

**Create**
- `packages/shared/src/protocol/messages.ts` — extended (unions grow; see Task 1)
- `packages/daemon/src/storage/paths.ts` — path helpers
- `packages/daemon/src/storage/meta.ts` — SessionMeta type + atomic read/write
- `packages/daemon/src/storage/SessionIndex.ts` — list + watch meta files
- `packages/daemon/src/session/SessionManager.ts` — active-session lifecycle + mutex
- `packages/daemon/src/session/Summarizer.ts` — build summary + title, write meta
- `packages/daemon/src/session/IdleSweeper.ts` — periodic idle close
- `packages/daemon/src/storage/migrate.ts` — one-time flat→folder migration
- `packages/web/src/ui/SessionList.tsx` — session rows + new/rename/delete
- Test files alongside each new module

**Modify**
- `packages/daemon/src/Daemon.ts` — remove `journal` opt, add `sessionsRoot`, wire SessionManager, route new commands
- `packages/daemon/src/session/Session.ts` — accept + consume one-shot `pendingResumeContext` on next turn
- `packages/daemon/src/engine/ClaudeAgentEngine.ts` — accept optional extra system prompt on first turn
- `packages/web/src/ui/Sidebar.tsx` — three vertical sections (new session / list / settings)
- `packages/web/src/ui/Transcript.tsx` — render `session_resumed` divider event
- `packages/web/src/Phase1Shell.tsx` — on send, if displayed ≠ active, dispatch `open_session { resume: true }` first
- `packages/web/src/session-model.ts` — track `activeSessionId`, `displayedSessionId`, `sessions[]`
- `packages/web/src/protocol-client.ts` — helpers for the six new commands

---

## Task 1: Shared protocol types

**Files:**
- Modify: `packages/shared/src/protocol/messages.ts`
- Test: `packages/shared/test/messages.test.ts` (create if not present)

**Interfaces:**
- Consumes: existing `ApplicationCommand`, `ApplicationEvent`, `COMMAND_TYPES` set.
- Produces:
  - Commands: `CmdListSessions`, `CmdGetSessionJournal`, `CmdNewSession`, `CmdOpenSession`, `CmdDeleteSession`, `CmdRenameSession`.
  - Events (out-of-band replies): `EvtSessionsList`, `EvtSessionJournal`, `EvtSessionSwitched`, `EvtSessionDeleted`, `EvtSessionRenamed`.
  - In-journal event: `EvtSessionResumed` (rendered as a divider).
  - Shared type: `SessionMetaSummary = { id, title, lastActivityAt, status: "active" | "closed" }`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/messages.test.ts` (or append to existing):

```ts
import { describe, it, expect } from "vitest";
import { isCommand, isEvent, type ApplicationCommand, type ApplicationEvent } from "../src/protocol/messages.js";

describe("session sidebar protocol", () => {
  it("list_sessions is a command", () => {
    const c: ApplicationCommand = { type: "list_sessions" };
    expect(isCommand(c)).toBe(true);
  });
  it("new_session is a command", () => {
    const c: ApplicationCommand = { type: "new_session" };
    expect(isCommand(c)).toBe(true);
  });
  it("open_session accepts resume flag", () => {
    const c: ApplicationCommand = { type: "open_session", sessionId: "abc", resume: true };
    expect(isCommand(c)).toBe(true);
  });
  it("delete_session is a command", () => {
    const c: ApplicationCommand = { type: "delete_session", sessionId: "abc" };
    expect(isCommand(c)).toBe(true);
  });
  it("rename_session is a command", () => {
    const c: ApplicationCommand = { type: "rename_session", sessionId: "abc", title: "New title" };
    expect(isCommand(c)).toBe(true);
  });
  it("get_session_journal is a command", () => {
    const c: ApplicationCommand = { type: "get_session_journal", sessionId: "abc" };
    expect(isCommand(c)).toBe(true);
  });
  it("sessions_list is an event", () => {
    const e: ApplicationEvent = {
      type: "sessions_list",
      sessions: [{ id: "abc", title: "T", lastActivityAt: 1, status: "closed" }],
    };
    expect(isEvent(e)).toBe(true);
  });
  it("session_switched is an event", () => {
    const e: ApplicationEvent = {
      type: "session_switched",
      sessionId: "abc",
      meta: { id: "abc", title: null, lastActivityAt: 1, status: "active" },
    };
    expect(isEvent(e)).toBe(true);
  });
  it("session_resumed is an event", () => {
    const e: ApplicationEvent = { type: "session_resumed", ts: 1, previousSessionId: "prev" };
    expect(isEvent(e)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — must fail**

Run: `cd packages/shared && npx vitest run test/messages.test.ts`
Expected: FAIL — `type "list_sessions" is not assignable to ApplicationCommand`.

- [ ] **Step 3: Add the types**

In `packages/shared/src/protocol/messages.ts`, add these interfaces near the other `Cmd*` definitions (around line 145):

```ts
export interface SessionMetaSummary {
  id: string;
  /** null until the summarizer has written a title. */
  title: string | null;
  /** epoch ms of the last user or assistant message. */
  lastActivityAt: number;
  status: "active" | "closed";
}

export interface CmdListSessions {
  type: "list_sessions";
}

export interface CmdGetSessionJournal {
  type: "get_session_journal";
  sessionId: string;
  /** Paged fetch. Undefined starts at the beginning. */
  cursor?: number;
  /** Default 100. */
  limit?: number;
}

export interface CmdNewSession {
  type: "new_session";
}

export interface CmdOpenSession {
  type: "open_session";
  sessionId: string;
  /** true → daemon switches active session and primes summary for next turn. */
  resume: boolean;
}

export interface CmdDeleteSession {
  type: "delete_session";
  sessionId: string;
}

export interface CmdRenameSession {
  type: "rename_session";
  sessionId: string;
  title: string;
}
```

Add them to the `ApplicationCommand` union at line ~170:

```ts
export type ApplicationCommand =
  | CmdUserMessage
  | CmdPermissionResponse
  | CmdPolicyUpdate
  | CmdSwitchWorkspace
  | CmdSessionConfig
  | CmdFileRequest
  | CmdBundleRequest
  | CmdInterrupt
  | CmdSessionControl
  | CmdResume
  | CmdAck
  | CmdListSessions
  | CmdGetSessionJournal
  | CmdNewSession
  | CmdOpenSession
  | CmdDeleteSession
  | CmdRenameSession;
```

Add events near the other `Evt*` definitions (around line 270):

```ts
export interface EvtSessionsList {
  type: "sessions_list";
  sessions: SessionMetaSummary[];
}

export interface EvtSessionJournal {
  type: "session_journal";
  sessionId: string;
  /** Journal records, oldest first. */
  events: ApplicationEvent[];
  /** Present when there are more events past this batch. */
  nextCursor?: number;
}

export interface EvtSessionSwitched {
  type: "session_switched";
  sessionId: string;
  meta: SessionMetaSummary;
}

export interface EvtSessionDeleted {
  type: "session_deleted";
  sessionId: string;
}

export interface EvtSessionRenamed {
  type: "session_renamed";
  sessionId: string;
  title: string;
}

/**
 * Written to a journal when a session is resumed (either via New→existing or Open→resume).
 * Rendered as a "Resumed <timestamp>" divider in the transcript.
 */
export interface EvtSessionResumed {
  type: "session_resumed";
  ts: number;
  /** The session that was active immediately before this resume (if any). */
  previousSessionId?: string;
}
```

Add them to the `ApplicationEvent` union at line ~298:

```ts
export type ApplicationEvent =
  | EvtAssistantDelta
  | EvtAssistantMessage
  | EvtToolUse
  | EvtToolStream
  | EvtToolResult
  | EvtPermissionRequest
  | EvtSessionStatus
  | EvtMachineState
  | EvtSystemMessage
  | EvtError
  | EvtTurnComplete
  | EvtSessionEnded
  | EvtFileData
  | EvtSessionsList
  | EvtSessionJournal
  | EvtSessionSwitched
  | EvtSessionDeleted
  | EvtSessionRenamed
  | EvtSessionResumed;
```

Update `COMMAND_TYPES` (search for the `new Set<CommandType>` around line 319) to include every new command type string: `"list_sessions"`, `"get_session_journal"`, `"new_session"`, `"open_session"`, `"delete_session"`, `"rename_session"`.

- [ ] **Step 4: Run test — must pass**

Run: `cd packages/shared && npx vitest run test/messages.test.ts && npm run typecheck`
Expected: PASS. Typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(protocol): session-sidebar commands and events"
```

---

## Task 2: Path + meta helpers

**Files:**
- Create: `packages/daemon/src/storage/paths.ts`
- Create: `packages/daemon/src/storage/meta.ts`
- Test: `packages/daemon/test/paths.test.ts`
- Test: `packages/daemon/test/meta.test.ts`

**Interfaces:**
- Consumes: `SessionMetaSummary` from `@wcc/shared`.
- Produces:
  - `sessionsRoot(workspaceRoot: string): string` → `<workspace>/.wcc/sessions`
  - `sessionDir(workspaceRoot, id): string`
  - `journalPath(workspaceRoot, id): string`
  - `metaPath(workspaceRoot, id): string`
  - `activePath(workspaceRoot): string` → `<workspace>/.wcc/active.json`
  - `type SessionMeta = { id, title, summary, startedAt, endedAt, lastActivityAt, status }`
  - `readMeta(dir): Promise<SessionMeta | null>`
  - `writeMetaAtomic(dir, meta): Promise<void>` (write to `.meta.json.tmp` then rename)
  - `readActive(workspaceRoot): Promise<string | null>`
  - `writeActive(workspaceRoot, sessionId): Promise<void>`

- [ ] **Step 1: Write failing tests**

`packages/daemon/test/paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sep } from "node:path";
import {
  sessionsRoot,
  sessionDir,
  journalPath,
  metaPath,
  activePath,
} from "../src/storage/paths.js";

describe("paths", () => {
  const root = "/ws";
  it("sessionsRoot", () => {
    expect(sessionsRoot(root).split(sep).join("/")).toBe("/ws/.wcc/sessions");
  });
  it("sessionDir", () => {
    expect(sessionDir(root, "abc").split(sep).join("/")).toBe("/ws/.wcc/sessions/abc");
  });
  it("journalPath", () => {
    expect(journalPath(root, "abc").split(sep).join("/")).toBe("/ws/.wcc/sessions/abc/journal.jsonl");
  });
  it("metaPath", () => {
    expect(metaPath(root, "abc").split(sep).join("/")).toBe("/ws/.wcc/sessions/abc/meta.json");
  });
  it("activePath", () => {
    expect(activePath(root).split(sep).join("/")).toBe("/ws/.wcc/active.json");
  });
});
```

`packages/daemon/test/meta.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMeta, writeMetaAtomic, readActive, writeActive } from "../src/storage/meta.js";

describe("meta.json", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wcc-meta-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("readMeta returns null when missing", async () => {
    expect(await readMeta(dir)).toBeNull();
  });

  it("writeMetaAtomic then readMeta", async () => {
    const meta = { id: "a", title: null, summary: null, startedAt: 1, endedAt: null, lastActivityAt: 1, status: "active" as const };
    await writeMetaAtomic(dir, meta);
    expect(await readMeta(dir)).toEqual(meta);
  });

  it("writeMetaAtomic does not leave a .tmp file", async () => {
    const meta = { id: "a", title: null, summary: null, startedAt: 1, endedAt: null, lastActivityAt: 1, status: "active" as const };
    await writeMetaAtomic(dir, meta);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("readActive/writeActive", async () => {
    expect(await readActive(dir)).toBeNull();
    await writeActive(dir, "abc");
    expect(await readActive(dir)).toBe("abc");
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `cd packages/daemon && npx vitest run test/paths.test.ts test/meta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `paths.ts`**

```ts
// packages/daemon/src/storage/paths.ts
import { join } from "node:path";

export const sessionsRoot = (workspaceRoot: string): string =>
  join(workspaceRoot, ".wcc", "sessions");

export const sessionDir = (workspaceRoot: string, id: string): string =>
  join(sessionsRoot(workspaceRoot), id);

export const journalPath = (workspaceRoot: string, id: string): string =>
  join(sessionDir(workspaceRoot, id), "journal.jsonl");

export const metaPath = (workspaceRoot: string, id: string): string =>
  join(sessionDir(workspaceRoot, id), "meta.json");

export const activePath = (workspaceRoot: string): string =>
  join(workspaceRoot, ".wcc", "active.json");
```

- [ ] **Step 4: Implement `meta.ts`**

```ts
// packages/daemon/src/storage/meta.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activePath } from "./paths.js";

export interface SessionMeta {
  id: string;
  title: string | null;
  summary: string | null;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  status: "active" | "closed";
}

export async function readMeta(dir: string): Promise<SessionMeta | null> {
  try {
    const text = await readFile(join(dir, "meta.json"), "utf8");
    return JSON.parse(text) as SessionMeta;
  } catch {
    return null;
  }
}

export async function writeMetaAtomic(dir: string, meta: SessionMeta): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.meta.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await rename(tmp, join(dir, "meta.json"));
}

export async function readActive(workspaceRoot: string): Promise<string | null> {
  try {
    const text = await readFile(activePath(workspaceRoot), "utf8");
    const obj = JSON.parse(text) as { activeSessionId?: string };
    return obj.activeSessionId ?? null;
  } catch {
    return null;
  }
}

export async function writeActive(workspaceRoot: string, sessionId: string): Promise<void> {
  const p = activePath(workspaceRoot);
  await mkdir(join(workspaceRoot, ".wcc"), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ activeSessionId: sessionId }), "utf8");
  await rename(tmp, p);
}
```

- [ ] **Step 5: Run tests — must pass**

Run: `cd packages/daemon && npx vitest run test/paths.test.ts test/meta.test.ts`
Expected: PASS on all 9 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/storage/paths.ts packages/daemon/src/storage/meta.ts packages/daemon/test/paths.test.ts packages/daemon/test/meta.test.ts
git commit -m "feat(daemon): session storage path + meta helpers"
```

---

## Task 3: SessionIndex

**Files:**
- Create: `packages/daemon/src/storage/SessionIndex.ts`
- Test: `packages/daemon/test/SessionIndex.test.ts`

**Interfaces:**
- Consumes: `readMeta` from Task 2, `SessionMetaSummary` from `@wcc/shared`.
- Produces:
  - `class SessionIndex`
  - Constructor: `new SessionIndex({ workspaceRoot: string, onChange?: () => void })`
  - `refresh(): Promise<void>` — rescan `sessions/*/meta.json`.
  - `list(): SessionMetaSummary[]` — cached view, sorted by `lastActivityAt` desc.
  - `start(): Promise<void>` — initial refresh + fs watch.
  - `stop(): void` — close watcher.

- [ ] **Step 1: Write failing test**

`packages/daemon/test/SessionIndex.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../src/storage/SessionIndex.js";
import { writeMetaAtomic } from "../src/storage/meta.js";
import { sessionDir } from "../src/storage/paths.js";

describe("SessionIndex", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-idx-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const writeSession = async (id: string, lastActivityAt: number, title: string | null) => {
    const dir = sessionDir(root, id);
    await mkdir(dir, { recursive: true });
    await writeMetaAtomic(dir, {
      id, title, summary: null, startedAt: 0, endedAt: null,
      lastActivityAt, status: "closed",
    });
  };

  it("empty root lists nothing", async () => {
    const idx = new SessionIndex({ workspaceRoot: root });
    await idx.start();
    expect(idx.list()).toEqual([]);
    idx.stop();
  });

  it("lists sessions sorted by lastActivityAt desc", async () => {
    await writeSession("a", 100, "A");
    await writeSession("b", 300, "B");
    await writeSession("c", 200, "C");
    const idx = new SessionIndex({ workspaceRoot: root });
    await idx.start();
    expect(idx.list().map((s) => s.id)).toEqual(["b", "c", "a"]);
    idx.stop();
  });

  it("refresh picks up new sessions", async () => {
    const idx = new SessionIndex({ workspaceRoot: root });
    await idx.start();
    await writeSession("z", 1, "Z");
    await idx.refresh();
    expect(idx.list().map((s) => s.id)).toEqual(["z"]);
    idx.stop();
  });

  it("skips folders without meta.json", async () => {
    await mkdir(sessionDir(root, "junk"), { recursive: true });
    await writeSession("a", 1, "A");
    const idx = new SessionIndex({ workspaceRoot: root });
    await idx.start();
    expect(idx.list().map((s) => s.id)).toEqual(["a"]);
    idx.stop();
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `cd packages/daemon && npx vitest run test/SessionIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SessionIndex.ts`**

```ts
// packages/daemon/src/storage/SessionIndex.ts
import { readdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import type { SessionMetaSummary } from "@wcc/shared";
import { readMeta } from "./meta.js";
import { sessionDir, sessionsRoot } from "./paths.js";

export interface SessionIndexOptions {
  workspaceRoot: string;
  onChange?: () => void;
}

export class SessionIndex {
  private readonly workspaceRoot: string;
  private readonly onChange?: () => void;
  private items: SessionMetaSummary[] = [];
  private watcher: FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;

  constructor(opts: SessionIndexOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.onChange = opts.onChange;
  }

  async start(): Promise<void> {
    await this.refresh();
    try {
      this.watcher = watch(sessionsRoot(this.workspaceRoot), { persistent: false }, () => {
        if (this.pending) return;
        this.pending = setTimeout(() => {
          this.pending = null;
          void this.refresh().then(() => this.onChange?.());
        }, 100); // debounce
      });
    } catch {
      // sessionsRoot may not exist yet; refresh() created nothing, watcher optional.
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pending) clearTimeout(this.pending);
  }

  async refresh(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(sessionsRoot(this.workspaceRoot));
    } catch {
      this.items = [];
      return;
    }
    const found: SessionMetaSummary[] = [];
    for (const id of entries) {
      const meta = await readMeta(sessionDir(this.workspaceRoot, id));
      if (!meta) continue;
      found.push({ id: meta.id, title: meta.title, lastActivityAt: meta.lastActivityAt, status: meta.status });
    }
    found.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    this.items = found;
  }

  list(): SessionMetaSummary[] {
    return [...this.items];
  }
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `cd packages/daemon && npx vitest run test/SessionIndex.test.ts`
Expected: PASS on all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/storage/SessionIndex.ts packages/daemon/test/SessionIndex.test.ts
git commit -m "feat(daemon): SessionIndex for meta.json listing + fs watch"
```

---

## Task 4: Legacy → folder migration

**Files:**
- Create: `packages/daemon/src/storage/migrate.ts`
- Test: `packages/daemon/test/migrate.test.ts`

**Interfaces:**
- Consumes: paths helpers, meta helpers.
- Produces: `migrateLegacySessions(workspaceRoot, now: () => number): Promise<{ migrated: string[] }>` — for every flat file `sessions/<id>.jsonl` (no directory), create `sessions/<id>/journal.jsonl` and a stub `meta.json`. Idempotent.

- [ ] **Step 1: Write failing test**

`packages/daemon/test/migrate.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacySessions } from "../src/storage/migrate.js";
import { sessionsRoot, journalPath, metaPath } from "../src/storage/paths.js";
import { readMeta } from "../src/storage/meta.js";

describe("migrateLegacySessions", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-mig-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("no-op on empty root", async () => {
    const result = await migrateLegacySessions(root, () => 1000);
    expect(result.migrated).toEqual([]);
  });

  it("wraps flat *.jsonl into folder + stub meta", async () => {
    await mkdir(sessionsRoot(root), { recursive: true });
    await writeFile(join(sessionsRoot(root), "old.jsonl"), '{"kind":"event","seq":1,"ts":1,"event":{"type":"assistant_message","text":"hi"}}\n');
    const result = await migrateLegacySessions(root, () => 5000);
    expect(result.migrated).toEqual(["old"]);
    // original journal preserved at new path
    const s = await stat(journalPath(root, "old"));
    expect(s.isFile()).toBe(true);
    // meta stub written
    const meta = await readMeta(join(sessionsRoot(root), "old"));
    expect(meta).toMatchObject({ id: "old", status: "closed", lastActivityAt: 5000 });
  });

  it("is idempotent", async () => {
    await mkdir(sessionsRoot(root), { recursive: true });
    await writeFile(join(sessionsRoot(root), "old.jsonl"), "");
    await migrateLegacySessions(root, () => 1);
    const second = await migrateLegacySessions(root, () => 2);
    expect(second.migrated).toEqual([]);
  });

  it("ignores non-jsonl files and existing folders", async () => {
    await mkdir(join(sessionsRoot(root), "already"), { recursive: true });
    await writeFile(join(sessionsRoot(root), "README.md"), "");
    const result = await migrateLegacySessions(root, () => 1);
    expect(result.migrated).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `cd packages/daemon && npx vitest run test/migrate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `migrate.ts`**

```ts
// packages/daemon/src/storage/migrate.ts
import { readdir, rename, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { sessionsRoot, sessionDir, journalPath } from "./paths.js";
import { readMeta, writeMetaAtomic, type SessionMeta } from "./meta.js";

export async function migrateLegacySessions(
  workspaceRoot: string,
  now: () => number,
): Promise<{ migrated: string[] }> {
  const root = sessionsRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { migrated: [] };
  }
  const migrated: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(root, name);
    const s = await stat(full);
    if (!s.isFile()) continue;
    const id = name.slice(0, -".jsonl".length);
    const dir = sessionDir(workspaceRoot, id);
    // If dir already exists, skip (idempotent).
    try {
      await stat(dir);
      continue;
    } catch { /* dir absent → migrate */ }
    await mkdir(dir, { recursive: true });
    await rename(full, journalPath(workspaceRoot, id));
    const existing = await readMeta(dir);
    if (!existing) {
      const meta: SessionMeta = {
        id,
        title: null,
        summary: null,
        startedAt: now(),
        endedAt: null,
        lastActivityAt: now(),
        status: "closed",
      };
      await writeMetaAtomic(dir, meta);
    }
    migrated.push(id);
  }
  return { migrated };
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `cd packages/daemon && npx vitest run test/migrate.test.ts`
Expected: PASS on all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/storage/migrate.ts packages/daemon/test/migrate.test.ts
git commit -m "feat(daemon): migrate legacy flat session journals into folders"
```

---

## Task 5: Add `ulid` dependency

**Files:**
- Modify: `packages/daemon/package.json`

- [ ] **Step 1: Install**

```bash
cd packages/daemon && npm install ulid
```

- [ ] **Step 2: Verify import works — write micro test**

`packages/daemon/test/ulid-smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ulid } from "ulid";

describe("ulid dep", () => {
  it("produces 26-char strings that sort by time", async () => {
    const a = ulid();
    await new Promise((r) => setTimeout(r, 2));
    const b = ulid();
    expect(a.length).toBe(26);
    expect(a < b).toBe(true);
  });
});
```

Run: `cd packages/daemon && npx vitest run test/ulid-smoke.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/package.json packages/daemon/package-lock.json package-lock.json packages/daemon/test/ulid-smoke.test.ts
git commit -m "chore(daemon): add ulid for session ids"
```

---

## Task 6: SessionManager

**Files:**
- Create: `packages/daemon/src/session/SessionManager.ts`
- Test: `packages/daemon/test/SessionManager.test.ts`

**Interfaces:**
- Consumes: `SessionIndex`, `SessionStorage`, `FileJournal`, `readMeta`/`writeMetaAtomic`/`readActive`/`writeActive`, `ulid`, `SessionMeta`, `EvtSessionResumed`, `Summarizer` (Task 8 — but SessionManager only takes a summarize *callback*, so it's decoupled).
- Produces:
  - `class SessionManager` with:
    - `constructor({ workspaceRoot, index, now, summarize })`
      - `summarize: (sessionId: string) => void` — fire-and-forget hook, no return.
    - `initialize(): Promise<{ activeId: string; storage: SessionStorage }>` — loads/creates active session at boot. Calls `migrateLegacySessions` internally.
    - `getActiveId(): string`
    - `getStorage(): SessionStorage` — the current storage.
    - `list(): SessionMetaSummary[]`
    - `newSession(): Promise<{ id: string; storage: SessionStorage }>` — closes current (fires summarize), mints ULID, returns new storage.
    - `openSession({ id, resume }): Promise<{ storage: SessionStorage; resumeContext: string | null } | null>` — null if id unknown or is active. resume=true switches; resume=false is a no-op (caller uses `readJournal`).
    - `readJournal(id, cursor?, limit?): Promise<{ events, nextCursor? }>` — read-only.
    - `deleteSession(id): Promise<boolean>` — false if active.
    - `renameSession(id, title): Promise<boolean>`
    - `touch(): Promise<void>` — update `lastActivityAt` of the active session (called on every append).
  - Internally serialized by a single async mutex on state transitions (`newSession` / `openSession` / `deleteSession`).

- [ ] **Step 1: Write failing test**

`packages/daemon/test/SessionManager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session/SessionManager.js";
import { SessionIndex } from "../src/storage/SessionIndex.js";

describe("SessionManager", () => {
  let root: string;
  let clock: number;
  const now = () => clock;
  const noSummarize = () => { /* noop */ };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wcc-sm-"));
    clock = 1000;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const makeMgr = async () => {
    const index = new SessionIndex({ workspaceRoot: root });
    const mgr = new SessionManager({ workspaceRoot: root, index, now, summarize: noSummarize });
    await mgr.initialize();
    await index.start();
    return { mgr, index };
  };

  it("initialize creates a fresh active session on empty workspace", async () => {
    const { mgr } = await makeMgr();
    const id = mgr.getActiveId();
    expect(id).toBeTruthy();
    expect(mgr.list().length).toBe(1);
    expect(mgr.list()[0]!.status).toBe("active");
  });

  it("newSession closes current and mints a new one", async () => {
    const { mgr, index } = await makeMgr();
    const first = mgr.getActiveId();
    clock = 2000;
    const { id: second } = await mgr.newSession();
    expect(second).not.toBe(first);
    await index.refresh();
    expect(mgr.list().find((s) => s.id === first)?.status).toBe("closed");
    expect(mgr.list().find((s) => s.id === second)?.status).toBe("active");
  });

  it("openSession(resume:true) switches active", async () => {
    const { mgr, index } = await makeMgr();
    const first = mgr.getActiveId();
    await mgr.newSession();
    clock = 3000;
    const result = await mgr.openSession({ id: first, resume: true });
    expect(result).not.toBeNull();
    expect(mgr.getActiveId()).toBe(first);
    await index.refresh();
    expect(mgr.list().find((s) => s.id === first)?.status).toBe("active");
  });

  it("openSession(resume:false) is a no-op on active", async () => {
    const { mgr } = await makeMgr();
    const before = mgr.getActiveId();
    const result = await mgr.openSession({ id: before, resume: false });
    expect(result).toBeNull();
    expect(mgr.getActiveId()).toBe(before);
  });

  it("deleteSession refuses active", async () => {
    const { mgr } = await makeMgr();
    const id = mgr.getActiveId();
    expect(await mgr.deleteSession(id)).toBe(false);
  });

  it("deleteSession removes closed session", async () => {
    const { mgr, index } = await makeMgr();
    const first = mgr.getActiveId();
    await mgr.newSession();
    expect(await mgr.deleteSession(first)).toBe(true);
    await index.refresh();
    expect(mgr.list().find((s) => s.id === first)).toBeUndefined();
  });

  it("renameSession updates title", async () => {
    const { mgr, index } = await makeMgr();
    const id = mgr.getActiveId();
    expect(await mgr.renameSession(id, "Hello")).toBe(true);
    await index.refresh();
    expect(mgr.list().find((s) => s.id === id)?.title).toBe("Hello");
  });

  it("resumeContext is the closed session's summary", async () => {
    const { mgr } = await makeMgr();
    const first = mgr.getActiveId();
    // manually finalize the summary as if summarizer had run
    const { writeMetaAtomic } = await import("../src/storage/meta.js");
    const { sessionDir } = await import("../src/storage/paths.js");
    await writeMetaAtomic(sessionDir(root, first), {
      id: first, title: "T", summary: "SUMMARY_TEXT",
      startedAt: 1, endedAt: 2, lastActivityAt: 2, status: "closed",
    });
    await mgr.newSession();
    const result = await mgr.openSession({ id: first, resume: true });
    expect(result?.resumeContext).toBe("SUMMARY_TEXT");
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `cd packages/daemon && npx vitest run test/SessionManager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SessionManager.ts`**

```ts
// packages/daemon/src/session/SessionManager.ts
import { mkdir, rm } from "node:fs/promises";
import { ulid } from "ulid";
import type { ApplicationEvent, SessionMetaSummary } from "@wcc/shared";
import { FileJournal } from "../storage/journal.js";
import { SessionStorage } from "../storage/SessionStorage.js";
import { SessionIndex } from "../storage/SessionIndex.js";
import {
  readMeta,
  writeMetaAtomic,
  readActive,
  writeActive,
  type SessionMeta,
} from "../storage/meta.js";
import { journalPath, sessionDir } from "../storage/paths.js";
import { migrateLegacySessions } from "../storage/migrate.js";

export interface SessionManagerOptions {
  workspaceRoot: string;
  index: SessionIndex;
  now: () => number;
  /** Fire-and-forget request to summarize a closed session. */
  summarize: (sessionId: string) => void;
}

export interface ResumeResult {
  storage: SessionStorage;
  resumeContext: string | null;
}

export class SessionManager {
  private readonly workspaceRoot: string;
  private readonly index: SessionIndex;
  private readonly now: () => number;
  private readonly summarize: (id: string) => void;
  private activeId: string | null = null;
  private storage: SessionStorage | null = null;
  private mutex: Promise<void> = Promise.resolve();

  constructor(opts: SessionManagerOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.index = opts.index;
    this.now = opts.now;
    this.summarize = opts.summarize;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let resolveNext!: () => void;
    this.mutex = new Promise<void>((r) => { resolveNext = r; });
    return prev.then(fn).finally(resolveNext);
  }

  async initialize(): Promise<{ activeId: string; storage: SessionStorage }> {
    await migrateLegacySessions(this.workspaceRoot, this.now);
    await this.index.refresh();
    const active = await readActive(this.workspaceRoot);
    if (active) {
      const meta = await readMeta(sessionDir(this.workspaceRoot, active));
      if (meta) {
        await this.attach(active);
        // ensure meta shows status active
        if (meta.status !== "active") {
          await writeMetaAtomic(sessionDir(this.workspaceRoot, active), { ...meta, status: "active" });
          await this.index.refresh();
        }
        return { activeId: active, storage: this.storage! };
      }
    }
    // No usable active — mint one.
    const id = await this.mint();
    return { activeId: id, storage: this.storage! };
  }

  private async attach(id: string): Promise<void> {
    const journal = await FileJournal.open(journalPath(this.workspaceRoot, id));
    const storage = new SessionStorage({ sessionId: id, journal });
    await storage.load();
    this.storage = storage;
    this.activeId = id;
    await writeActive(this.workspaceRoot, id);
  }

  private async mint(): Promise<string> {
    const id = ulid();
    const dir = sessionDir(this.workspaceRoot, id);
    await mkdir(dir, { recursive: true });
    const meta: SessionMeta = {
      id, title: null, summary: null,
      startedAt: this.now(), endedAt: null,
      lastActivityAt: this.now(), status: "active",
    };
    await writeMetaAtomic(dir, meta);
    await this.attach(id);
    await this.index.refresh();
    return id;
  }

  private async close(id: string): Promise<void> {
    const dir = sessionDir(this.workspaceRoot, id);
    const meta = await readMeta(dir);
    if (!meta) return;
    await writeMetaAtomic(dir, { ...meta, status: "closed", endedAt: this.now() });
    // fire-and-forget summarizer
    this.summarize(id);
  }

  getActiveId(): string {
    if (!this.activeId) throw new Error("SessionManager not initialized");
    return this.activeId;
  }

  getStorage(): SessionStorage {
    if (!this.storage) throw new Error("SessionManager not initialized");
    return this.storage;
  }

  list(): SessionMetaSummary[] {
    return this.index.list();
  }

  newSession(): Promise<{ id: string; storage: SessionStorage }> {
    return this.withLock(async () => {
      const old = this.activeId;
      if (old) await this.close(old);
      const id = await this.mint();
      return { id, storage: this.storage! };
    });
  }

  openSession(args: { id: string; resume: boolean }): Promise<ResumeResult | null> {
    return this.withLock(async () => {
      if (args.id === this.activeId) return null;
      if (!args.resume) return null;
      const dir = sessionDir(this.workspaceRoot, args.id);
      const meta = await readMeta(dir);
      if (!meta) return null;
      const old = this.activeId;
      if (old) await this.close(old);
      // Reopen the target
      await writeMetaAtomic(dir, { ...meta, status: "active" });
      await this.attach(args.id);
      // Write session_resumed marker into the journal as a normal event.
      const resumed: ApplicationEvent = { type: "session_resumed", ts: this.now(), previousSessionId: old ?? undefined };
      this.storage!.append(resumed);
      await this.index.refresh();
      return { storage: this.storage!, resumeContext: meta.summary };
    });
  }

  async readJournal(id: string, cursor = 0, limit = 100): Promise<{ events: ApplicationEvent[]; nextCursor?: number }> {
    const journal = await FileJournal.open(journalPath(this.workspaceRoot, id));
    try {
      const records = await journal.readAll();
      const events = records.filter((r) => r.kind === "event").map((r) => (r as { event: ApplicationEvent }).event);
      const slice = events.slice(cursor, cursor + limit);
      const next = cursor + slice.length < events.length ? cursor + slice.length : undefined;
      return { events: slice, ...(next !== undefined ? { nextCursor: next } : {}) };
    } finally {
      await journal.close();
    }
  }

  deleteSession(id: string): Promise<boolean> {
    return this.withLock(async () => {
      if (id === this.activeId) return false;
      await rm(sessionDir(this.workspaceRoot, id), { recursive: true, force: true });
      await this.index.refresh();
      return true;
    });
  }

  async renameSession(id: string, title: string): Promise<boolean> {
    const dir = sessionDir(this.workspaceRoot, id);
    const meta = await readMeta(dir);
    if (!meta) return false;
    await writeMetaAtomic(dir, { ...meta, title });
    await this.index.refresh();
    return true;
  }

  async touch(): Promise<void> {
    if (!this.activeId) return;
    const dir = sessionDir(this.workspaceRoot, this.activeId);
    const meta = await readMeta(dir);
    if (!meta) return;
    await writeMetaAtomic(dir, { ...meta, lastActivityAt: this.now() });
  }
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `cd packages/daemon && npx vitest run test/SessionManager.test.ts`
Expected: PASS on all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/session/SessionManager.ts packages/daemon/test/SessionManager.test.ts
git commit -m "feat(daemon): SessionManager owns active-session lifecycle"
```

---

## Task 7: Session `pendingResumeContext`

**Files:**
- Modify: `packages/daemon/src/session/Session.ts`
- Test: `packages/daemon/test/Session.resume.test.ts`

**Interfaces:**
- Consumes: existing Session shape.
- Produces:
  - New method `Session.setPendingResumeContext(text: string): void` — one-shot.
  - New optional field on the engine invocation call: `resumeContext?: string`. Engine reads and clears.

Existing engine invocation happens inside `Session.handleCommand` / a `runTurn` path. Find that call site (`packages/daemon/src/session/Session.ts:1-475`). Add:
1. Private field `private pendingResumeContext: string | null = null;`
2. Public method `setPendingResumeContext(text: string): void { this.pendingResumeContext = text; }`
3. Where the engine is invoked, extract `const rc = this.pendingResumeContext; this.pendingResumeContext = null;` and pass `rc` into the engine call as `resumeContext`.

- [ ] **Step 1: Write failing test**

`packages/daemon/test/Session.resume.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryJournal } from "../src/storage/journal.js";
import { SessionStorage } from "../src/storage/SessionStorage.js";
import { MockEngine } from "../src/engine/MockEngine.js";
import { Session, type OutgoingEvent } from "../src/session/Session.js";
import { Workspace } from "../src/workspace/workspace.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Session.setPendingResumeContext", () => {
  it("consumes context on the next engine call, then clears it", async () => {
    const root = mkdtempSync(join(tmpdir(), "wcc-sess-"));
    try {
      const workspace = new Workspace({ workspaceId: "default", name: "t", root });
      const journal = new InMemoryJournal();
      const storage = new SessionStorage({ sessionId: "s1", journal });
      const engine = new MockEngine();
      const out: OutgoingEvent[] = [];
      const session = new Session({
        sessionId: "s1", workspace, engine, storage,
        deliver: (o) => out.push(o), permissionTimeoutMs: 50,
      });
      session.setPendingResumeContext("RESUME_CTX");
      await session.handleCommand("browser-1", { type: "user_message", text: "hi" });
      // MockEngine should have received resumeContext on first call
      expect(engine.lastResumeContext).toBe("RESUME_CTX");
      // Second call, no resume context
      await session.handleCommand("browser-1", { type: "user_message", text: "again" });
      expect(engine.lastResumeContext).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Add resumeContext support to MockEngine**

Locate `MockEngine.ts`. Add a public field `lastResumeContext: string | null = null;` and update the `connect` / `send` path to store the incoming `resumeContext` argument (default null).

Concretely, wherever MockEngine has a method that mirrors the SDK query (search `packages/daemon/src/engine/MockEngine.ts` for the equivalent of `send`/`connect`), add a parameter and store it. Do the same on the `IAgentEngine` interface in `@wcc/shared` if needed. If `IAgentEngine.send` currently takes `{ text, attachments }`, extend to `{ text, attachments, resumeContext? }`.

- [ ] **Step 3: Wire Session to pass it**

In `Session.ts`, at the engine-invocation site (search for `.send(` or the equivalent inside the turn runner), add:

```ts
const resumeContext = this.pendingResumeContext;
this.pendingResumeContext = null;
// ... existing engine call, extended:
await this.engine.send({ text: userText, attachments, resumeContext });
```

Add the field + method near the top of the class:

```ts
private pendingResumeContext: string | null = null;
setPendingResumeContext(text: string): void {
  this.pendingResumeContext = text;
}
```

- [ ] **Step 4: Wire ClaudeAgentEngine to inject the extra system prompt**

In `packages/daemon/src/engine/ClaudeAgentEngine.ts`, find where the SDK `query` options are constructed. When `resumeContext` is present on the first prompt of a session, prepend it as an extra system prompt fragment. The SDK accepts a `systemPrompt` option; append (with a leading separator) if already set. Concretely:

```ts
// where SdkQueryArgs.options is built:
const options: Record<string, unknown> = { ...baseOptions };
if (resumeContext) {
  const banner = `[Prior session context — do not repeat back to user]\n${resumeContext}`;
  const existing = typeof options.systemPrompt === "string" ? options.systemPrompt : "";
  options.systemPrompt = existing ? `${existing}\n\n${banner}` : banner;
}
```

- [ ] **Step 5: Run tests — must pass**

Run: `cd packages/daemon && npx vitest run test/Session.resume.test.ts && npx vitest run test/Session.test.ts`
Expected: PASS. No regressions in existing Session tests.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src packages/shared/src packages/daemon/test/Session.resume.test.ts
git commit -m "feat(daemon): one-shot resumeContext plumbed through Session to engine"
```

---

## Task 8: Summarizer

**Files:**
- Create: `packages/daemon/src/session/Summarizer.ts`
- Test: `packages/daemon/test/Summarizer.test.ts`

**Interfaces:**
- Consumes: `IAgentEngine` (or a narrower `SummarizerEngine` interface), `readMeta`/`writeMetaAtomic`, `FileJournal.readAll`.
- Produces:
  - `interface SummarizerEngine { summarize(prompt: string): Promise<{ title: string; summary: string }>; }`
  - `class Summarizer` with:
    - `constructor({ workspaceRoot, engine, now, log })`
    - `run(sessionId: string): Promise<void>` — reads journal, builds prompt, calls engine, writes meta. Best-effort; catches errors and falls back title to first user message truncated.

- [ ] **Step 1: Write failing test**

`packages/daemon/test/Summarizer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Summarizer, type SummarizerEngine } from "../src/session/Summarizer.js";
import { sessionDir, journalPath } from "../src/storage/paths.js";
import { writeMetaAtomic, readMeta } from "../src/storage/meta.js";

const seed = async (root: string, id: string) => {
  const dir = sessionDir(root, id);
  await mkdir(dir, { recursive: true });
  await writeMetaAtomic(dir, {
    id, title: null, summary: null, startedAt: 1, endedAt: 2, lastActivityAt: 2, status: "closed",
  });
  const lines = [
    { kind: "event", seq: 1, ts: 1, event: { type: "user_message", text: "Fix the login bug" } },
    { kind: "event", seq: 2, ts: 2, event: { type: "assistant_message", text: "Looked at auth.ts, patched race." } },
  ];
  await writeFile(journalPath(root, id), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

describe("Summarizer", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-sum-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("writes title + summary from engine reply", async () => {
    await seed(root, "s1");
    const engine: SummarizerEngine = {
      async summarize() { return { title: "Fix login bug", summary: "Patched auth race" }; },
    };
    const s = new Summarizer({ workspaceRoot: root, engine, now: () => 99 });
    await s.run("s1");
    const meta = await readMeta(sessionDir(root, "s1"));
    expect(meta?.title).toBe("Fix login bug");
    expect(meta?.summary).toBe("Patched auth race");
  });

  it("falls back to first user message on engine error", async () => {
    await seed(root, "s2");
    const engine: SummarizerEngine = {
      async summarize() { throw new Error("boom"); },
    };
    const s = new Summarizer({ workspaceRoot: root, engine, now: () => 1 });
    await s.run("s2");
    const meta = await readMeta(sessionDir(root, "s2"));
    expect(meta?.title).toBe("Fix the login bug");
    expect(meta?.summary).toBeNull();
  });

  it("skips empty sessions and deletes their folder", async () => {
    // No user messages
    const dir = sessionDir(root, "empty");
    await mkdir(dir, { recursive: true });
    await writeMetaAtomic(dir, {
      id: "empty", title: null, summary: null, startedAt: 1, endedAt: 2, lastActivityAt: 2, status: "closed",
    });
    await writeFile(journalPath(root, "empty"), "");
    const engine: SummarizerEngine = { async summarize() { throw new Error("should not be called"); } };
    const s = new Summarizer({ workspaceRoot: root, engine, now: () => 1 });
    await s.run("empty");
    const meta = await readMeta(sessionDir(root, "empty"));
    expect(meta).toBeNull(); // folder removed
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `cd packages/daemon && npx vitest run test/Summarizer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `Summarizer.ts`**

```ts
// packages/daemon/src/session/Summarizer.ts
import { rm } from "node:fs/promises";
import { FileJournal } from "../storage/journal.js";
import { readMeta, writeMetaAtomic } from "../storage/meta.js";
import { journalPath, sessionDir } from "../storage/paths.js";

export interface SummarizerEngine {
  summarize(prompt: string): Promise<{ title: string; summary: string }>;
}

export interface SummarizerOptions {
  workspaceRoot: string;
  engine: SummarizerEngine;
  now: () => number;
  log?: (level: "info" | "warn", msg: string, meta?: Record<string, unknown>) => void;
}

const MAX_TITLE = 60;

export class Summarizer {
  constructor(private readonly opts: SummarizerOptions) {}

  async run(sessionId: string): Promise<void> {
    const dir = sessionDir(this.opts.workspaceRoot, sessionId);
    const meta = await readMeta(dir);
    if (!meta) return;
    const journal = await FileJournal.open(journalPath(this.opts.workspaceRoot, sessionId));
    const records = await journal.readAll();
    await journal.close();

    const userMsgs: string[] = [];
    const asstMsgs: string[] = [];
    const tools = new Set<string>();
    for (const r of records) {
      if (r.kind !== "event") continue;
      const e = r.event;
      if (e.type === "user_message") userMsgs.push(e.text);
      else if (e.type === "assistant_message") asstMsgs.push(e.text);
      else if (e.type === "tool_use") tools.add(e.name);
    }

    if (userMsgs.length === 0) {
      // Empty session — delete the folder entirely.
      await rm(dir, { recursive: true, force: true });
      return;
    }

    const prompt = buildPrompt(userMsgs, asstMsgs, [...tools]);

    let title: string;
    let summary: string | null;
    try {
      const result = await this.opts.engine.summarize(prompt);
      title = result.title.slice(0, MAX_TITLE);
      summary = result.summary;
    } catch (err) {
      this.opts.log?.("warn", "summarizer failed", { sessionId, err: String(err) });
      title = userMsgs[0]!.slice(0, MAX_TITLE);
      summary = null;
    }

    await writeMetaAtomic(dir, { ...meta, title, summary });
  }
}

function buildPrompt(user: string[], asst: string[], tools: string[]): string {
  return [
    "Summarize the following conversation for later resume.",
    "Return ONLY compact JSON: { \"title\": string, \"summary\": string }",
    "- title: ≤60 chars, imperative or noun phrase.",
    "- summary: focused on user goal, decisions, unfinished threads, key file paths / commands. ≤800 tokens.",
    "",
    "USER:", ...user.map((t) => "- " + t.replace(/\s+/g, " ").slice(0, 500)),
    "",
    "ASSISTANT:", ...asst.map((t) => "- " + t.replace(/\s+/g, " ").slice(0, 500)),
    "",
    "TOOLS:", tools.join(", "),
  ].join("\n");
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `cd packages/daemon && npx vitest run test/Summarizer.test.ts`
Expected: PASS on all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/session/Summarizer.ts packages/daemon/test/Summarizer.test.ts
git commit -m "feat(daemon): Summarizer produces title+summary on session close"
```

---

## Task 9: IdleSweeper

**Files:**
- Create: `packages/daemon/src/session/IdleSweeper.ts`
- Test: `packages/daemon/test/IdleSweeper.test.ts`

**Interfaces:**
- Consumes: `SessionManager`.
- Produces:
  - `class IdleSweeper` — `constructor({ manager, now, idleMs = 6*60*60*1000, tickMs = 15*60*1000 })`
  - `start(): void` / `stop(): void`
  - `tick(): Promise<void>` — public for tests. If active session's `lastActivityAt < now - idleMs`, calls `manager.newSession()`.

- [ ] **Step 1: Write failing test**

`packages/daemon/test/IdleSweeper.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdleSweeper } from "../src/session/IdleSweeper.js";
import { SessionManager } from "../src/session/SessionManager.js";
import { SessionIndex } from "../src/storage/SessionIndex.js";

describe("IdleSweeper", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-idle-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("does nothing when active session is fresh", async () => {
    let clock = 1000;
    const index = new SessionIndex({ workspaceRoot: root });
    const mgr = new SessionManager({ workspaceRoot: root, index, now: () => clock, summarize: () => {} });
    await mgr.initialize();
    const before = mgr.getActiveId();
    const sweeper = new IdleSweeper({ manager: mgr, now: () => clock, idleMs: 100 });
    clock = 1050; // less than 100 later
    await sweeper.tick();
    expect(mgr.getActiveId()).toBe(before);
  });

  it("rolls to new session when idle exceeds threshold", async () => {
    let clock = 1000;
    const index = new SessionIndex({ workspaceRoot: root });
    const mgr = new SessionManager({ workspaceRoot: root, index, now: () => clock, summarize: () => {} });
    await mgr.initialize();
    const before = mgr.getActiveId();
    const sweeper = new IdleSweeper({ manager: mgr, now: () => clock, idleMs: 100 });
    clock = 2000;
    await sweeper.tick();
    expect(mgr.getActiveId()).not.toBe(before);
  });
});
```

- [ ] **Step 2: Implement `IdleSweeper.ts`**

```ts
// packages/daemon/src/session/IdleSweeper.ts
import { readMeta } from "../storage/meta.js";
import { sessionDir } from "../storage/paths.js";
import type { SessionManager } from "./SessionManager.js";

export interface IdleSweeperOptions {
  manager: SessionManager;
  workspaceRoot?: string; // if omitted, uses manager.getWorkspaceRoot equivalent through readMeta
  now: () => number;
  idleMs?: number;
  tickMs?: number;
}

export class IdleSweeper {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly opts: IdleSweeperOptions) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.opts.tickMs ?? 15 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const idle = this.opts.idleMs ?? 6 * 60 * 60 * 1000;
    const id = this.opts.manager.getActiveId();
    const workspaceRoot = (this.opts.manager as unknown as { workspaceRoot: string }).workspaceRoot
      ?? this.opts.workspaceRoot;
    if (!workspaceRoot) return;
    const meta = await readMeta(sessionDir(workspaceRoot, id));
    if (!meta) return;
    if (this.opts.now() - meta.lastActivityAt >= idle) {
      await this.opts.manager.newSession();
    }
  }
}
```

Also: expose `workspaceRoot` publicly from `SessionManager` — add `readonly workspaceRoot: string;` at the top of the class, assigned in the constructor. Adjust IdleSweeper to use `this.opts.manager.workspaceRoot` directly (delete the cast).

- [ ] **Step 3: Run tests — must pass**

Run: `cd packages/daemon && npx vitest run test/IdleSweeper.test.ts`
Expected: PASS on both tests.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/session/IdleSweeper.ts packages/daemon/src/session/SessionManager.ts packages/daemon/test/IdleSweeper.test.ts
git commit -m "feat(daemon): IdleSweeper rolls active session after 6h idle"
```

---

## Task 10: Wire SessionManager into Daemon

**Files:**
- Modify: `packages/daemon/src/Daemon.ts`
- Test: `packages/daemon/test/Daemon.integration.test.ts` (extend existing)

**Interfaces:**
- Consumes: `SessionManager`, `SessionIndex`, `Summarizer`, `IdleSweeper`.
- Produces: Daemon now:
  1. On construction takes `workspaceRoot` and no direct `journal`. It builds `SessionIndex`, `SessionManager`, `Summarizer`, `IdleSweeper`.
  2. Handles new commands (`list_sessions`, `get_session_journal`, `new_session`, `open_session`, `delete_session`, `rename_session`) via `SessionManager` and replies with the matching event.
  3. On `SessionIndex` change → broadcasts `sessions_list`.
  4. On active-session switch → broadcasts `session_switched` and (if resume) calls `Session.setPendingResumeContext` before the next turn begins.

Do this in one pass — the plumbing is intertwined enough that splitting hurts more than it helps. Read `packages/daemon/src/Daemon.ts` in full first.

- [ ] **Step 1: Update Daemon opts + construction**

In `Daemon.ts`:

- Remove `journal: JournalSink` from `DaemonOptions`.
- Add `workspaceRoot: string`.
- In the constructor, replace the direct `SessionStorage` construction with:

```ts
this.sessionIndex = new SessionIndex({
  workspaceRoot: opts.workspaceRoot,
  onChange: () => this.broadcastSessionsList(),
});
this.summarizer = new Summarizer({
  workspaceRoot: opts.workspaceRoot,
  engine: buildSummarizerEngine(this.engineFactory),
  now: () => Date.now(),
  log: (l, m, meta) => this.log(l === "info" ? "info" : "warn", m, meta),
});
this.sessionManager = new SessionManager({
  workspaceRoot: opts.workspaceRoot,
  index: this.sessionIndex,
  now: () => Date.now(),
  summarize: (id) => { void this.summarizer.run(id); },
});
```

- Add an async `initialize()` method (or extend an existing one) that calls `this.sessionManager.initialize()`, `this.sessionIndex.start()`, then constructs the initial `Session` with `manager.getStorage()`.
- Add `this.idleSweeper = new IdleSweeper({ manager: this.sessionManager, now: () => Date.now() }); this.idleSweeper.start();`

`buildSummarizerEngine`: a thin wrapper that reuses your existing `ClaudeAgentEngine` (or spawns a fresh one for a one-shot query) to produce `{ title, summary }`. If your engine has a `queryOnce(prompt): Promise<string>` helper, use it and JSON-parse the reply.

- [ ] **Step 2: Command dispatch**

Locate the switch that dispatches `CmdUserMessage`, `CmdInterrupt`, etc. (inside `Session.handleCommand` or the Daemon's inbound path — likely the former). For the new commands, dispatch **at the Daemon level, not Session**, because they affect which Session is active. Add branches:

```ts
// (inside the Daemon's applicationCommand handler, before it delegates to Session)
switch (cmd.type) {
  case "list_sessions":
    return this.replyList(clientId);
  case "get_session_journal":
    return this.replyJournal(clientId, cmd);
  case "new_session":
    return this.handleNewSession(clientId);
  case "open_session":
    return this.handleOpenSession(clientId, cmd);
  case "delete_session":
    return this.handleDeleteSession(clientId, cmd);
  case "rename_session":
    return this.handleRenameSession(clientId, cmd);
}
// fall through to Session.handleCommand for the rest
```

Handler bodies (all send a targeted `TransportEnvelope` back to `clientId`):

```ts
private async replyList(clientId: string) {
  const sessions = this.sessionManager.list();
  this.deliverTo(clientId, { type: "sessions_list", sessions });
}

private async replyJournal(clientId: string, cmd: CmdGetSessionJournal) {
  const { events, nextCursor } = await this.sessionManager.readJournal(cmd.sessionId, cmd.cursor, cmd.limit);
  this.deliverTo(clientId, { type: "session_journal", sessionId: cmd.sessionId, events, ...(nextCursor !== undefined ? { nextCursor } : {}) });
}

private async handleNewSession(clientId: string) {
  const { id } = await this.sessionManager.newSession();
  this.rebindSession();
  this.broadcast({ type: "session_switched", sessionId: id, meta: this.metaFor(id) });
  this.broadcastSessionsList();
}

private async handleOpenSession(clientId: string, cmd: CmdOpenSession) {
  if (!cmd.resume) {
    // Just serve the journal for read-only viewing.
    return this.replyJournal(clientId, { type: "get_session_journal", sessionId: cmd.sessionId });
  }
  const result = await this.sessionManager.openSession({ id: cmd.sessionId, resume: true });
  if (!result) {
    this.deliverTo(clientId, { type: "error", code: "session_not_found", message: cmd.sessionId });
    return;
  }
  this.rebindSession();
  if (result.resumeContext) this.session.setPendingResumeContext(result.resumeContext);
  this.broadcast({ type: "session_switched", sessionId: cmd.sessionId, meta: this.metaFor(cmd.sessionId) });
  this.broadcastSessionsList();
}

private async handleDeleteSession(clientId: string, cmd: CmdDeleteSession) {
  const ok = await this.sessionManager.deleteSession(cmd.sessionId);
  if (!ok) {
    this.deliverTo(clientId, { type: "error", code: "session_delete_refused", message: cmd.sessionId });
    return;
  }
  this.broadcast({ type: "session_deleted", sessionId: cmd.sessionId });
  this.broadcastSessionsList();
}

private async handleRenameSession(clientId: string, cmd: CmdRenameSession) {
  const ok = await this.sessionManager.renameSession(cmd.sessionId, cmd.title);
  if (!ok) return;
  this.broadcast({ type: "session_renamed", sessionId: cmd.sessionId, title: cmd.title });
  this.broadcastSessionsList();
}

private rebindSession() {
  // Replace this.session with a new Session bound to manager.getStorage().
  // The engine is the same instance; only the storage/sessionId changes.
  this.session = new Session({
    sessionId: this.sessionManager.getActiveId(),
    workspace: this.workspaceManager.active(),
    engine: this.engine,
    storage: this.sessionManager.getStorage(),
    deliver: this.deliverFn,
    permissionTimeoutMs: this.permissionTimeoutMs,
  });
}

private metaFor(id: string): SessionMetaSummary {
  return this.sessionManager.list().find((s) => s.id === id)!;
}

private broadcastSessionsList() {
  this.broadcast({ type: "sessions_list", sessions: this.sessionManager.list() });
}
```

Field names above (`this.deliverFn`, `this.deliverTo`, `this.broadcast`, `this.workspaceManager.active()`, `this.permissionTimeoutMs`) may not exist under those exact names — adapt to whatever the current Daemon uses (search for existing broadcasts of `EvtSystemMessage` or `EvtSessionStatus` to copy the pattern).

- [ ] **Step 3: Touch on every event append**

In `SessionStorage.append`, at the end, invoke a callback if provided: `this.opts.onAppend?.()`. Extend `SessionStorageOptions` with `onAppend?: () => void`. In `SessionManager.mint()` / `attach()`, pass `onAppend: () => { void this.touch(); }`.

- [ ] **Step 4: Extend existing integration test**

In `packages/daemon/test/Daemon.integration.test.ts`, add a test that:
1. Constructs Daemon with a temp workspace.
2. Sends `new_session` → expects `session_switched` broadcast.
3. Sends a `user_message` on the old session id (via `open_session {resume:true}` first) → expects the mock engine to have received a `resumeContext`.
4. Sends `list_sessions` → expects both ids in the reply, active status correct.
5. Sends `delete_session` on the closed one → expects `session_deleted` broadcast.
6. Sends `get_session_journal` on the deleted id → expects an empty or error reply.

- [ ] **Step 5: Run all daemon tests**

Run: `cd packages/daemon && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): route session-sidebar commands via SessionManager"
```

---

## Task 11: Web protocol-client wiring

**Files:**
- Modify: `packages/web/src/protocol-client.ts`

**Interfaces:**
- Consumes: existing send/receive helpers.
- Produces: six new send helpers (`listSessions()`, `newSession()`, `openSession(id, resume)`, `deleteSession(id)`, `renameSession(id, title)`, `getSessionJournal(id, cursor?, limit?)`).

- [ ] **Step 1: Add helpers**

Locate the client's send helper file (`protocol-client.ts`). For each new command, add a wrapper that mirrors the existing ones. Example — copy the exact style of `sendUserMessage` (whatever it looks like) and adapt:

```ts
export function listSessions(client: ProtocolClient): void {
  client.send({ type: "list_sessions" });
}

export function newSession(client: ProtocolClient): void {
  client.send({ type: "new_session" });
}

export function openSession(client: ProtocolClient, sessionId: string, resume: boolean): void {
  client.send({ type: "open_session", sessionId, resume });
}

export function deleteSession(client: ProtocolClient, sessionId: string): void {
  client.send({ type: "delete_session", sessionId });
}

export function renameSession(client: ProtocolClient, sessionId: string, title: string): void {
  client.send({ type: "rename_session", sessionId, title });
}

export function getSessionJournal(client: ProtocolClient, sessionId: string, cursor?: number, limit?: number): void {
  client.send({ type: "get_session_journal", sessionId, ...(cursor !== undefined ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) });
}
```

Names may differ — align with the file's existing style (functions vs methods on a client class).

- [ ] **Step 2: Typecheck**

Run: `cd packages/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/protocol-client.ts
git commit -m "feat(web): protocol-client helpers for session sidebar"
```

---

## Task 12: Web session model

**Files:**
- Modify: `packages/web/src/session-model.ts`
- Test: `packages/web/test/session-model.test.ts` (create if not present)

**Interfaces:**
- Consumes: incoming events `sessions_list`, `session_switched`, `session_deleted`, `session_renamed`, `session_journal`.
- Produces:
  - Extend the model state with `activeSessionId: string | null`, `displayedSessionId: string | null`, `sessions: SessionMetaSummary[]`, `displayedJournal: ApplicationEvent[] | null`.
  - Reducers:
    - On `sessions_list` → set `sessions`.
    - On `session_switched` → set `activeSessionId`; if `displayedSessionId == null` also set `displayedSessionId = activeSessionId`.
    - On `session_deleted` → drop from `sessions`; if it was `displayedSessionId`, set to active.
    - On `session_renamed` → patch title in `sessions`.
    - On `session_journal` (with sessionId matching `displayedSessionId`) → replace `displayedJournal` with events (or append when cursor > 0).
  - Actions the UI can invoke:
    - `viewSession(id)` — sets `displayedSessionId`, sends `get_session_journal` if it's not the active one.
    - `startNewSession()` — clears displayedJournal, sends `new_session`.
    - `resumeIfNeededAndSend(text)` — if `displayedSessionId !== activeSessionId`, sends `open_session {resume:true}`, then queues the message; otherwise sends the message directly.

- [ ] **Step 1: Write failing tests**

`packages/web/test/session-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSessionModel } from "../src/session-model.js";
import type { SessionMetaSummary } from "@wcc/shared";

describe("session model", () => {
  const s = (id: string, title: string | null = null): SessionMetaSummary => ({
    id, title, lastActivityAt: 1, status: "closed",
  });

  it("sessions_list updates sessions", () => {
    const m = createSessionModel();
    m.receive({ type: "sessions_list", sessions: [s("a"), s("b")] });
    expect(m.state().sessions.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("session_switched sets active + defaults displayed", () => {
    const m = createSessionModel();
    m.receive({ type: "session_switched", sessionId: "a", meta: { ...s("a"), status: "active" } });
    expect(m.state().activeSessionId).toBe("a");
    expect(m.state().displayedSessionId).toBe("a");
  });

  it("session_deleted removes from sessions list", () => {
    const m = createSessionModel();
    m.receive({ type: "sessions_list", sessions: [s("a"), s("b")] });
    m.receive({ type: "session_deleted", sessionId: "a" });
    expect(m.state().sessions.map((x) => x.id)).toEqual(["b"]);
  });

  it("session_renamed patches title", () => {
    const m = createSessionModel();
    m.receive({ type: "sessions_list", sessions: [s("a", "Old")] });
    m.receive({ type: "session_renamed", sessionId: "a", title: "New" });
    expect(m.state().sessions.find((x) => x.id === "a")?.title).toBe("New");
  });

  it("viewSession switches displayed and requests journal if not active", () => {
    const sent: unknown[] = [];
    const m = createSessionModel({ send: (msg) => sent.push(msg) });
    m.receive({ type: "session_switched", sessionId: "a", meta: { ...s("a"), status: "active" } });
    m.viewSession("b");
    expect(m.state().displayedSessionId).toBe("b");
    expect(sent.some((x: any) => x.type === "get_session_journal" && x.sessionId === "b")).toBe(true);
  });
});
```

- [ ] **Step 2: Implement / extend `session-model.ts`**

Extend or create `createSessionModel({ send })` following the shape above. The existing file already has some session state — add the new fields and reducers alongside.

- [ ] **Step 3: Run tests — must pass**

Run: `cd packages/web && npx vitest run test/session-model.test.ts`
Expected: PASS on all 5 tests.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/session-model.ts packages/web/test/session-model.test.ts
git commit -m "feat(web): session-model tracks active/displayed and sessions list"
```

---

## Task 13: Web `SessionList` component

**Files:**
- Create: `packages/web/src/ui/SessionList.tsx`
- Test: `packages/web/test/SessionList.test.tsx` (React Testing Library — add if missing)

**Interfaces:**
- Props:
  ```ts
  {
    sessions: SessionMetaSummary[];
    activeId: string | null;
    displayedId: string | null;
    onNewSession: () => void;
    onOpen: (id: string) => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
  }
  ```
- Renders:
  - A "+ New session" button.
  - `<hr>`.
  - "Sessions" label.
  - One row per session with dot (filled for active), title (or "(untitled, N messages)" fallback if `title == null`), relative timestamp, "Summarizing…" label if `title == null && status == "closed"`.
  - Long-press / right-click → context menu with Rename / Delete. Delete disabled on active row.

- [ ] **Step 1: Write failing test (RTL)**

`packages/web/test/SessionList.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionList } from "../src/ui/SessionList.js";
import type { SessionMetaSummary } from "@wcc/shared";

const s = (id: string, title: string | null, status: "active" | "closed" = "closed"): SessionMetaSummary =>
  ({ id, title, lastActivityAt: Date.now(), status });

describe("SessionList", () => {
  it("renders + New session button", () => {
    render(
      <SessionList sessions={[]} activeId={null} displayedId={null}
        onNewSession={() => {}} onOpen={() => {}} onRename={() => {}} onDelete={() => {}} />
    );
    expect(screen.getByRole("button", { name: /new session/i })).toBeTruthy();
  });

  it("clicking + New session calls onNewSession", () => {
    const spy = vi.fn();
    render(
      <SessionList sessions={[]} activeId={null} displayedId={null}
        onNewSession={spy} onOpen={() => {}} onRename={() => {}} onDelete={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    expect(spy).toHaveBeenCalledOnce();
  });

  it("shows Summarizing… for closed sessions with null title", () => {
    render(
      <SessionList sessions={[s("a", null, "closed")]} activeId={null} displayedId={null}
        onNewSession={() => {}} onOpen={() => {}} onRename={() => {}} onDelete={() => {}} />
    );
    expect(screen.getByText(/summarizing/i)).toBeTruthy();
  });

  it("clicking a row calls onOpen", () => {
    const spy = vi.fn();
    render(
      <SessionList sessions={[s("a", "Hello")]} activeId={null} displayedId={null}
        onNewSession={() => {}} onOpen={spy} onRename={() => {}} onDelete={() => {}} />
    );
    fireEvent.click(screen.getByText(/hello/i));
    expect(spy).toHaveBeenCalledWith("a");
  });

  it("active row shows a filled dot", () => {
    const { container } = render(
      <SessionList sessions={[s("a", "T", "active")]} activeId="a" displayedId="a"
        onNewSession={() => {}} onOpen={() => {}} onRename={() => {}} onDelete={() => {}} />
    );
    expect(container.querySelector(".session-dot.active")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement component**

```tsx
// packages/web/src/ui/SessionList.tsx
import { useState } from "react";
import type { SessionMetaSummary } from "@wcc/shared";

export interface SessionListProps {
  sessions: SessionMetaSummary[];
  activeId: string | null;
  displayedId: string | null;
  onNewSession: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function SessionList({
  sessions, activeId, displayedId,
  onNewSession, onOpen, onRename, onDelete,
}: SessionListProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);

  return (
    <div className="session-list">
      <button className="btn primary block" onClick={onNewSession}>+ New session</button>
      <hr className="sidebar-sep" />
      <div className="sidebar-label">Sessions</div>
      {sessions.length === 0 ? (
        <div className="sidebar-help">No sessions yet.</div>
      ) : (
        <ul className="session-rows">
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            const isDisplayed = s.id === displayedId;
            const isSummarizing = s.status === "closed" && s.title === null;
            const label = s.title ?? "(untitled)";
            return (
              <li key={s.id}
                  className={`session-row ${isDisplayed ? "displayed" : ""}`}
                  onClick={() => onOpen(s.id)}
                  onContextMenu={(e) => { e.preventDefault(); setMenuFor(s.id); }}>
                <span className={`session-dot ${isActive ? "active" : ""}`} />
                <div className="session-row-body">
                  <div className="session-row-title">{isSummarizing ? "Summarizing…" : label}</div>
                  <div className="session-row-sub">{relative(s.lastActivityAt)}</div>
                </div>
                {menuFor === s.id && (
                  <div className="session-menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => {
                      const t = window.prompt("Rename session", s.title ?? "");
                      if (t !== null && t.trim().length > 0) onRename(s.id, t.trim());
                      setMenuFor(null);
                    }}>Rename</button>
                    <button
                      disabled={isActive}
                      onClick={() => {
                        if (window.confirm("Delete this session? This cannot be undone.")) onDelete(s.id);
                        setMenuFor(null);
                      }}>Delete</button>
                    <button onClick={() => setMenuFor(null)}>Cancel</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function relative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
```

Also add matching CSS to `packages/web/src/styles.css`:

```css
.session-list { display: flex; flex-direction: column; gap: 8px; }
.session-rows { list-style: none; padding: 0; margin: 0; }
.session-row { display: flex; gap: 8px; padding: 8px; border-radius: 6px; cursor: pointer; position: relative; }
.session-row:hover { background: var(--hover); }
.session-row.displayed { background: var(--selected); }
.session-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: transparent; border: 1px solid var(--border); }
.session-dot.active { background: var(--accent); border-color: var(--accent); }
.session-row-body { flex: 1; min-width: 0; }
.session-row-title { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-row-sub { font-size: 12px; opacity: 0.6; }
.session-menu { position: absolute; right: 8px; top: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; display: flex; flex-direction: column; z-index: 2; }
.session-menu button { padding: 6px 12px; text-align: left; }
.sidebar-sep { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.btn.block { width: 100%; }
```

Reuse existing CSS variables — check `styles.css` for what's already defined (`--border`, `--accent`, etc.) and substitute if the names differ.

- [ ] **Step 3: Run tests — must pass**

Run: `cd packages/web && npx vitest run test/SessionList.test.tsx`
Expected: PASS on all 5 tests.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/ui/SessionList.tsx packages/web/src/styles.css packages/web/test/SessionList.test.tsx
git commit -m "feat(web): SessionList component"
```

---

## Task 14: Integrate SessionList into Sidebar

**Files:**
- Modify: `packages/web/src/ui/Sidebar.tsx`

**Interfaces:**
- Consumes: `SessionList`, session-model state and actions.
- Produces: new Sidebar layout — sessions block on top, hr, settings block at bottom.

- [ ] **Step 1: Extend `Sidebar` props**

```tsx
// packages/web/src/ui/Sidebar.tsx (top of file)
import { SessionList } from "./SessionList.js";
import type { SessionMetaSummary } from "@wcc/shared";

export function Sidebar({
  open, onClose,
  identity, machine, theme, onToggleTheme,
  // NEW:
  sessions, activeSessionId, displayedSessionId,
  onNewSession, onOpenSession, onRenameSession, onDeleteSession,
}: {
  open: boolean;
  onClose: () => void;
  identity: Identity | null;
  machine: MachineState | undefined;
  theme: Theme;
  onToggleTheme: () => void;
  sessions: SessionMetaSummary[];
  activeSessionId: string | null;
  displayedSessionId: string | null;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
}) {
```

Rearrange the body so top-to-bottom is:

```tsx
<aside className={`sidebar ${open ? "open" : ""}`}>
  <div className="sidebar-head">
    <div className="sidebar-title">WebClaudeCode</div>
    <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
  </div>

  <section className="sidebar-section">
    <SessionList
      sessions={sessions}
      activeId={activeSessionId}
      displayedId={displayedSessionId}
      onNewSession={onNewSession}
      onOpen={onOpenSession}
      onRename={onRenameSession}
      onDelete={onDeleteSession}
    />
  </section>

  <hr className="sidebar-sep" />

  <section className="sidebar-section">
    <div className="sidebar-label">Settings</div>
    {/* existing machine + theme + pairing-key blocks, unchanged */}
  </section>
</aside>
```

- [ ] **Step 2: Wire props from `Phase1Shell`**

In `Phase1Shell.tsx`, connect Sidebar props to session-model state and dispatch:

```tsx
<Sidebar
  open={sidebarOpen}
  onClose={() => setSidebarOpen(false)}
  identity={identity}
  machine={machine}
  theme={theme}
  onToggleTheme={toggleTheme}
  sessions={model.sessions}
  activeSessionId={model.activeSessionId}
  displayedSessionId={model.displayedSessionId}
  onNewSession={() => model.startNewSession()}
  onOpenSession={(id) => model.viewSession(id)}
  onRenameSession={(id, title) => model.renameSession(id, title)}
  onDeleteSession={(id) => model.deleteSession(id)}
/>
```

- [ ] **Step 3: Manual smoke check**

Run: `cd packages/web && npm run dev` (in the background). Open the phone/browser as usual. Open the sidebar; confirm the three sections render in order. `+ New session` should produce a new row.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/ui/Sidebar.tsx packages/web/src/Phase1Shell.tsx
git commit -m "feat(web): integrate SessionList into Sidebar drawer"
```

---

## Task 15: Resume-on-first-message flow

**Files:**
- Modify: `packages/web/src/Phase1Shell.tsx` (or wherever `Composer` submit is wired).

**Interfaces:**
- Consumes: session model.
- Produces: send-flow that dispatches `open_session {resume:true}` before the user message when `displayedSessionId !== activeSessionId`.

- [ ] **Step 1: Wrap the existing send**

Locate the current Composer submit handler. Replace direct `sendUserMessage(text)` with:

```ts
async function onSubmit(text: string, attachments: Attachment[]) {
  const st = model.state();
  if (st.displayedSessionId && st.displayedSessionId !== st.activeSessionId) {
    // queue: switch first, then send after session_switched arrives
    model.pendingSend = { text, attachments };
    openSession(client, st.displayedSessionId, true);
    return;
  }
  sendUserMessage(client, text, attachments);
}
```

And in the model's `session_switched` reducer:

```ts
if (this.pendingSend) {
  const p = this.pendingSend;
  this.pendingSend = null;
  sendUserMessage(this.client, p.text, p.attachments);
}
```

Show a subtle "Resuming…" state in the Composer while `pendingSend != null`.

- [ ] **Step 2: Add test**

`packages/web/test/resume-flow.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createSessionModel } from "../src/session-model.js";

describe("resume-on-first-send", () => {
  it("sends open_session before the user_message when displayed != active", async () => {
    const sent: any[] = [];
    const m = createSessionModel({ send: (msg) => sent.push(msg) });
    m.receive({ type: "session_switched", sessionId: "current", meta: { id: "current", title: null, lastActivityAt: 1, status: "active" } });
    m.viewSession("old"); // displayed = old, active = current
    m.submitUserMessage("hi", []);
    // First outbound: open_session with resume:true
    expect(sent[sent.length - 1]).toMatchObject({ type: "open_session", sessionId: "old", resume: true });
    // Now the daemon replies:
    m.receive({ type: "session_switched", sessionId: "old", meta: { id: "old", title: "t", lastActivityAt: 1, status: "active" } });
    // Should have flushed the queued message:
    expect(sent[sent.length - 1]).toMatchObject({ type: "user_message", text: "hi" });
  });

  it("sends user_message directly when displayed == active", () => {
    const sent: any[] = [];
    const m = createSessionModel({ send: (msg) => sent.push(msg) });
    m.receive({ type: "session_switched", sessionId: "a", meta: { id: "a", title: null, lastActivityAt: 1, status: "active" } });
    m.submitUserMessage("hi", []);
    expect(sent[sent.length - 1]).toMatchObject({ type: "user_message", text: "hi" });
  });
});
```

- [ ] **Step 3: Run — must pass**

Run: `cd packages/web && npx vitest run test/resume-flow.test.ts`
Expected: PASS on both tests.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src packages/web/test/resume-flow.test.ts
git commit -m "feat(web): auto-resume when sending on a non-active session"
```

---

## Task 16: `session_resumed` divider in Transcript

**Files:**
- Modify: `packages/web/src/ui/Transcript.tsx`

**Interfaces:**
- Consumes: incoming `ApplicationEvent[]` stream.
- Produces: renders a subtle divider `Resumed <date time>` for each `session_resumed` event.

- [ ] **Step 1: Add render branch**

In the Transcript's event-to-JSX switch, add:

```tsx
case "session_resumed":
  return (
    <div className="transcript-divider" key={idx}>
      Resumed {new Date(ev.ts).toLocaleString()}
    </div>
  );
```

CSS in `styles.css`:

```css
.transcript-divider { text-align: center; font-size: 12px; opacity: 0.5; padding: 8px 0; border-top: 1px dashed var(--border); margin-top: 16px; }
```

- [ ] **Step 2: Smoke test**

Manually resume a session in the dev app; confirm the divider appears above the new user message.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/ui/Transcript.tsx packages/web/src/styles.css
git commit -m "feat(web): render session_resumed divider"
```

---

## Task 17: End-to-end integration test

**Files:**
- Create: `packages/e2e/test/session-sidebar.test.ts` (place under the existing `packages/e2e` if it holds integration tests; else `packages/daemon/test/`).

**Interfaces:**
- Consumes: real Daemon + MockEngine + in-memory transport.
- Produces: a scenario test covering three sessions, delete, resume with summary.

- [ ] **Step 1: Write scenario**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../daemon/src/Daemon.js"; // adjust path
import { MockEngine } from "../../daemon/src/engine/MockEngine.js";

describe("session sidebar e2e", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-e2e-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("create → chat → new → chat → delete → resume with summary", async () => {
    const engine = new MockEngine();
    // Provide a fake summarize output the engine returns:
    engine.summarizeResult = { title: "First topic", summary: "SUM_A" };
    const d = new Daemon({ workspaceRoot: root, engine, /* ...other required opts */ });
    await d.initialize();

    // 1. First user message on default session A
    await d.dispatch("browser-1", { type: "user_message", text: "hello A" });

    // 2. new_session → get id B
    await d.dispatch("browser-1", { type: "new_session" });
    const listed1 = await d.getLastBroadcast("sessions_list");
    expect(listed1.sessions.length).toBe(2);

    // 3. chat in B
    await d.dispatch("browser-1", { type: "user_message", text: "hello B" });

    // 4. open_session on A with resume:true → engine receives resumeContext SUM_A
    const aId = listed1.sessions.find((s) => s.status === "closed")!.id;
    await d.dispatch("browser-1", { type: "open_session", sessionId: aId, resume: true });
    await d.dispatch("browser-1", { type: "user_message", text: "hello again" });
    expect(engine.lastResumeContext).toBe("SUM_A");

    // 5. delete previously-active B
    const bId = listed1.sessions.find((s) => s.status === "active")!.id;
    await d.dispatch("browser-1", { type: "delete_session", sessionId: bId });
    const listed2 = await d.getLastBroadcast("sessions_list");
    expect(listed2.sessions.map((s) => s.id)).not.toContain(bId);
  });
});
```

Note: `d.dispatch` / `d.getLastBroadcast` / `d.initialize` may need small test harness shims — reuse whatever `Daemon.integration.test.ts` uses to drive the daemon. If the file exists as a template, copy its harness.

- [ ] **Step 2: Run**

Run: `cd packages/daemon && npx vitest run test/session-sidebar-e2e.test.ts` (or wherever placed).
Expected: PASS.

- [ ] **Step 3: Full suite green-light**

Run from repo root: `npm test`
Expected: all packages PASS.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "test(e2e): session sidebar scenario"
```

---

## Post-implementation

- Manual smoke test on desktop + phone: create three sessions, rename one, delete one, resume an old one, verify the "Resumed …" divider and that the new turn benefits from the summary (ask Claude "what were we just doing?").
- Update [docs/PROGRESS.md](../../PROGRESS.md) with a P1 checkpoint mentioning multi-session support.

---

## Self-review notes

**Coverage check against spec:**
- Disk layout → Task 2 (paths), Task 6 (SessionManager builds folders), Task 4 (migration).
- SessionIndex → Task 3.
- SessionStorage path change → no code change needed; SessionManager constructs the FileJournal at the right path. Task 6.
- Daemon refactor → Task 10.
- Protocol additions → Task 1 (types) + Task 10 (handlers) + Task 11 (client helpers).
- Summary + title generation → Task 8; wired in Task 10 (`summarize` callback into SessionManager).
- Idle fallback → Task 9.
- Resume flow → Task 6 (resumeContext plumbed through SessionManager.openSession), Task 7 (Session.setPendingResumeContext + engine injection), Task 10 (Daemon wires it), Task 15 (web resume-on-send).
- Sidebar UI → Task 13 + Task 14.
- session_resumed divider → Task 16.
- Edge cases:
  - Dirty exit — existing invariant, no code change needed.
  - Empty session — Task 8 (Summarizer deletes folder).
  - Rename collision — no unique constraint; UI shows timestamp (Task 13).
  - Delete active — Task 6 refuses; Task 13 disables the button; Task 10 returns an error.
  - Delete during summarize — Task 8 uses `readMeta`/`writeMetaAtomic` which no-op on missing dir (Task 8 code path).
  - Concurrent new_session — Task 6 mutex.
  - Long journals — Task 6.readJournal supports cursor/limit; Task 1 protocol supports it.
  - Journal corruption — existing behavior in `journal.ts`, unchanged.
- Timezone rendering — Task 13 `relative()`.
