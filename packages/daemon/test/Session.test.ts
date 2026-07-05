import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ApplicationCommand,
  ApplicationEvent,
  EvtFileData,
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
  engine: MockEngine;
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
  return { session, out, journal, workspace, engine, root };
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

  it("applies session_config to the engine and echoes model + effort in session_status", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand(
      { type: "session_config", model: "claude-opus-4-8", effort: "high" },
      CLIENT,
    );
    // Delegated to the engine…
    expect(h.engine.config).toEqual({ model: "claude-opus-4-8", effort: "high" });
    // …and reflected in the status snapshot the UI reads.
    const status = broadcasts(h.out).filter((e) => e.type === "session_status").at(-1) as
      | Extract<ApplicationEvent, { type: "session_status" }>
      | undefined;
    expect(status?.model).toBe("claude-opus-4-8");
    expect(status?.effort).toBe("high");
  });

  it("forwards user_message attachments to the engine", async () => {
    const h = makeHarness(root);
    await h.session.start();
    await h.session.handleCommand(
      {
        type: "user_message",
        text: "look at this",
        attachments: [{ name: "shot.png", mediaType: "image/png", data: "QUJD" }],
      },
      CLIENT,
    );
    await waitUntil(() => firstOfType(h.out, "turn_complete") !== undefined);
    // MockEngine echoes the attachment names it received.
    const echoed = broadcasts(h.out).some(
      (e) => e.type === "assistant_message" && e.text.includes("shot.png"),
    );
    expect(echoed).toBe(true);
  });

  it("serves a file_request by returning the file bytes (base64), targeted to the requesting client", async () => {
    const h = makeHarness(root);
    await h.session.start();
    writeFileSync(join(root, "report.md"), "# hello\n", "utf8");

    await h.session.handleCommand({ type: "file_request", requestId: "fr-1", path: "report.md" }, CLIENT);

    const data = h.out.find((o) => o.to === CLIENT && o.event.type === "file_data");
    expect(data).toBeDefined();
    const evt = data!.event as EvtFileData;
    expect(evt.requestId).toBe("fr-1");
    expect(evt.name).toBe("report.md");
    expect(evt.error).toBeUndefined();
    expect(Buffer.from(evt.data!, "base64").toString("utf8")).toBe("# hello\n");
  });

  it("rejects a file_request that escapes the workspace root", async () => {
    const h = makeHarness(root);
    await h.session.start();

    await h.session.handleCommand(
      { type: "file_request", requestId: "fr-2", path: "../../secret.txt" },
      CLIENT,
    );

    const data = h.out.find((o) => o.to === CLIENT && o.event.type === "file_data");
    const evt = data!.event as EvtFileData;
    expect(evt.data).toBeUndefined();
    expect(evt.error).toBeTruthy();
  });

  it("returns an error file_data for a missing file", async () => {
    const h = makeHarness(root);
    await h.session.start();

    await h.session.handleCommand({ type: "file_request", requestId: "fr-3", path: "nope.txt" }, CLIENT);

    const data = h.out.find((o) => o.to === CLIENT && o.event.type === "file_data");
    const evt = data!.event as EvtFileData;
    expect(evt.data).toBeUndefined();
    expect(evt.error).toBeTruthy();
  });

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
