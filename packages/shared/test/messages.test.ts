import { describe, expect, it } from "vitest";
import {
  isCommand,
  isEvent,
  requiresSignature,
  type Attachment,
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
