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
