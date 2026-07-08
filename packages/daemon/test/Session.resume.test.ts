import { describe, it, expect } from "vitest";
import { InMemoryJournal } from "../src/storage/journal.js";
import { SessionStorage } from "../src/storage/SessionStorage.js";
import { MockEngine } from "../src/engine/MockEngine.js";
import { Session, type OutgoingEvent } from "../src/session/Session.js";
import { Workspace } from "../src/workspace/workspace.js";
import { cleanupWorkspace, makeTempWorkspace, waitUntil } from "./helpers.js";

const CLIENT = "browser-1";

describe("Session.setPendingResumeContext", () => {
  it("consumes context on the next engine call, then clears it", async () => {
    const root = makeTempWorkspace();
    try {
      const workspace = new Workspace({ workspaceId: "default", name: "t", root });
      const journal = new InMemoryJournal();
      const storage = new SessionStorage({ sessionId: "s1", journal });
      const engine = new MockEngine();
      const out: OutgoingEvent[] = [];
      const session = new Session({
        sessionId: "s1",
        workspace,
        engine,
        storage,
        deliver: (o) => out.push(o),
        permissionTimeoutMs: 50,
      });
      await session.start();

      session.setPendingResumeContext("RESUME_CTX");
      await session.handleCommand({ type: "user_message", text: "hi" }, CLIENT);
      await waitUntil(() => engine.lastResumeContext !== null);
      // MockEngine should have received resumeContext on first call
      expect(engine.lastResumeContext).toBe("RESUME_CTX");

      // Wait for the first turn to finish before starting the second.
      await waitUntil(() => session.getState() === "idle");

      // Second call, no resume context
      await session.handleCommand({ type: "user_message", text: "again" }, CLIENT);
      await waitUntil(() => session.getState() !== "idle" || engine.lastResumeContext === null);
      expect(engine.lastResumeContext).toBeNull();
    } finally {
      cleanupWorkspace(root);
    }
  });
});
