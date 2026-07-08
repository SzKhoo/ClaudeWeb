import { describe, expect, it } from "vitest";
import {
  isCommand,
  isEvent,
  requiresSignature,
  type Attachment,
  type ApplicationCommand,
  type ApplicationEvent,
  type CmdBundleRequest,
  type CmdFileRequest,
  type CmdUserMessage,
  type EvtFileData,
} from "../src/index.js";

describe("message classification — attachments + file transfer", () => {
  it("treats a user_message carrying attachments as a signed command", () => {
    const att: Attachment = { name: "photo.png", mediaType: "image/png", data: "AAAA" };
    const cmd: CmdUserMessage = { type: "user_message", text: "look at this", attachments: [att] };
    expect(isCommand(cmd)).toBe(true);
    expect(requiresSignature(cmd.type)).toBe(true);
  });

  it("treats file_request as a command that must be signed", () => {
    const cmd: CmdFileRequest = { type: "file_request", requestId: "r1", path: "out/report.md" };
    expect(isCommand(cmd)).toBe(true);
    expect(isEvent(cmd)).toBe(false);
    expect(requiresSignature("file_request")).toBe(true);
  });

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

  it("treats file_data as an unsigned daemon->client event", () => {
    const evt: EvtFileData = {
      type: "file_data",
      requestId: "r1",
      path: "out/report.md",
      name: "report.md",
      mediaType: "text/markdown",
      data: "aGk=",
    };
    expect(isEvent(evt)).toBe(true);
    expect(isCommand(evt)).toBe(false);
    expect(requiresSignature("file_data")).toBe(false);
  });
});

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
