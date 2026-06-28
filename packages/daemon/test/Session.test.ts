import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ApplicationCommand,
  ApplicationEvent,
  EvtPermissionRequest,
  EvtTurnComplete,
} from "@wcc/shared";
import { MockEngine } from "../src/engine/MockEngine.js";
import { InMemoryJournal } from "../src/storage/journal.js";
import { SessionStorage } from "../src/storage/SessionStorage.js";
import { Session, type OutgoingEvent } from "../src/session/Session.js";
import { Workspace } from "../src/workspace/workspace.js";
import { cleanupWorkspace, fileExists, makeTempWorkspace, readWorkspaceFile, waitUntil } from "./helpers.js";

const CLIENT = "browser-1";

interface Harness {
  session: Session;
  out: OutgoingEvent[];
  journal: InMemoryJournal;
  workspace: Workspace;
  root: string;
}

function makeHarness(root: string, journal = new InMemoryJournal()): Harness {
  const out: OutgoingEvent[] = [];
  const workspace = new Workspace({ workspaceId: "default", name: "test", root });
  const storage = new SessionStorage({ sessionId: "s1", journal });
  const engine = new MockEngine();
  const session = new Session({
    sessionId: "s1",
    workspace,
    engine,
    storage,
    deliver: (o) => out.push(o),
    permissionTimeoutMs: 50,
  });
  return { session, out, journal, workspace, root };
}

const broadcasts = (out: OutgoingEvent[]): ApplicationEvent[] =>
  out.filter((o) => o.to === "*").map((o) => o.event);

const firstOfType = <T extends ApplicationEvent["type"]>(
  out: OutgoingEvent[],
  type: T,
): Extract<ApplicationEvent, { type: T }> | undefined =>
  broadcasts(out).find((e) => e.type === type) as Extract<ApplicationEvent, { type: T }> | undefined;

const userMessage = (text: string): ApplicationCommand => ({ type: "user_message", text });

describe("Session", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempWorkspace();
  });
  afterEach(() => cleanupWorkspace(root));

  it("runs a turn, prompts for Write, and on approval actually writes the file", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand(userMessage('create hello.txt with content "hi there"'), CLIENT);

    await waitUntil(() => firstOfType(h.out, "permission_request") !== undefined);
    const req = firstOfType(h.out, "permission_request") as EvtPermissionRequest;
    expect(req.toolName).toBe("Write");
    expect(req.diff?.unified).toContain("hi there");
    // No file yet — gated on approval.
    expect(fileExists(root, "hello.txt")).toBe(false);

    await h.session.handleCommand(
      { type: "permission_response", requestId: req.requestId, decision: "approve" },
      CLIENT,
    );

    await waitUntil(() => firstOfType(h.out, "turn_complete") !== undefined);
    const done = firstOfType(h.out, "turn_complete") as EvtTurnComplete;
    expect(done.status).toBe("ok");
    expect(fileExists(root, "hello.txt")).toBe(true);
    expect(readWorkspaceFile(root, "hello.txt")).toBe("hi there");

    // Streamed stdout was stamped with a real cumulative offset by SessionStorage.
    const stream = firstOfType(h.out, "tool_stream");
    expect(stream?.offset).toBe(0);
  });

  it("denies the Write and leaves the file uncreated", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand(userMessage("create notes.txt"), CLIENT);
    await waitUntil(() => firstOfType(h.out, "permission_request") !== undefined);
    const req = firstOfType(h.out, "permission_request") as EvtPermissionRequest;

    await h.session.handleCommand(
      { type: "permission_response", requestId: req.requestId, decision: "deny" },
      CLIENT,
    );
    await waitUntil(() => firstOfType(h.out, "turn_complete") !== undefined);
    expect(fileExists(root, "notes.txt")).toBe(false);
  });

  it("ignores a permission response for an unknown/forged requestId without acting", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand(userMessage("create x.txt"), CLIENT);
    await waitUntil(() => firstOfType(h.out, "permission_request") !== undefined);

    await h.session.handleCommand(
      { type: "permission_response", requestId: "forged-id", decision: "approve" },
      CLIENT,
    );
    await new Promise((r) => setTimeout(r, 20));
    // The real request is still pending; nothing was written; a warning was surfaced.
    expect(fileExists(root, "x.txt")).toBe(false);
    const warned = broadcasts(h.out).some(
      (e) => e.type === "system_message" && e.text.includes("unknown request"),
    );
    expect(warned).toBe(true);
  });

  it("default-denies an unanswered permission after the timeout", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand(userMessage("create slow.txt"), CLIENT);
    await waitUntil(() => firstOfType(h.out, "permission_request") !== undefined);

    // Never answer — the 50ms timeout fires default-deny → turn completes, no file.
    await waitUntil(() => firstOfType(h.out, "turn_complete") !== undefined, 400);
    expect(fileExists(root, "slow.txt")).toBe(false);
    const timedOut = broadcasts(h.out).some(
      (e) => e.type === "system_message" && e.text.includes("timed out"),
    );
    expect(timedOut).toBe(true);
  });

  it("auto-approves Write under auto-edits policy (no prompt) and writes the file", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand({ type: "policy_update", executionMode: "auto-edits" }, CLIENT);
    await h.session.handleCommand(userMessage("create auto.txt"), CLIENT);

    await waitUntil(() => firstOfType(h.out, "turn_complete") !== undefined);
    expect(firstOfType(h.out, "permission_request")).toBeUndefined();
    expect(fileExists(root, "auto.txt")).toBe(true);
  });

  it("interrupts a turn that is awaiting approval", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand(userMessage("create never.txt"), CLIENT);
    await waitUntil(() => firstOfType(h.out, "permission_request") !== undefined);

    await h.session.handleCommand({ type: "interrupt" }, CLIENT);
    await waitUntil(() => firstOfType(h.out, "turn_complete") !== undefined);
    const done = firstOfType(h.out, "turn_complete") as EvtTurnComplete;
    expect(done.status).toBe("interrupted");
    expect(fileExists(root, "never.txt")).toBe(false);
  });

  it("backfills a reconnecting client (targeted) with events after sinceSeq plus a status snapshot", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand(userMessage("create r.txt"), CLIENT);
    await waitUntil(() => firstOfType(h.out, "permission_request") !== undefined);
    const req = firstOfType(h.out, "permission_request") as EvtPermissionRequest;
    await h.session.handleCommand(
      { type: "permission_response", requestId: req.requestId, decision: "approve" },
      CLIENT,
    );
    await waitUntil(() => firstOfType(h.out, "turn_complete") !== undefined);

    const broadcastCount = h.out.length;
    const midSeq = 2;
    await h.session.handleCommand({ type: "resume", sinceSeq: midSeq }, "browser-2");

    const targeted = h.out.slice(broadcastCount).filter((o) => o.to === "browser-2");
    expect(targeted.length).toBeGreaterThan(0);
    // All replayed log events are strictly after sinceSeq.
    for (const o of targeted) {
      if (o.event.type !== "session_status") expect(o.seq).toBeGreaterThan(midSeq);
    }
    // Last targeted frame is a current state snapshot.
    expect(targeted.at(-1)?.event.type).toBe("session_status");
  });

  it("recovers a dirty exit: an open turn in the journal becomes turn_complete error on start", async () => {
    const journal = new InMemoryJournal();
    journal.append({ kind: "turn_start", ts: Date.now(), turnId: "crashed-turn" });
    const h = makeHarness(root, journal);
    await h.session.start();

    const done = firstOfType(h.out, "turn_complete") as EvtTurnComplete | undefined;
    expect(done?.status).toBe("error");
    expect(done?.message).toContain("restarted");
    const warned = broadcasts(h.out).some(
      (e) => e.type === "system_message" && e.text.includes("restarted mid-turn"),
    );
    expect(warned).toBe(true);
  });
});
