/**
 * ClaudeAgentEngine unit tests — no real SDK.
 * Scripted `queryFn` drives the SDK message shapes the engine consumes; asserts the mapping to
 * IAgentEngine events, canUseTool → onPermissionRequest → approve/deny, interrupt semantics, and
 * session_id → ConversationCheckpoint. The live end-to-end path was proven separately by the 0A
 * gate spike (docs/notes/task-07-real-engine.md).
 */
import { describe, expect, it } from "vitest";
import type { EngineEvent, EnginePermissionRequest } from "@wcc/shared";
import {
  ClaudeAgentEngine,
  type SdkCanUseTool,
  type SdkMessage,
  type SdkQuery,
  type SdkQueryArgs,
} from "../src/engine/ClaudeAgentEngine.js";

interface Harness {
  emitFromSdk: (m: SdkMessage) => void;
  interruptSpy: () => number;
  canUseTool: () => SdkCanUseTool | undefined;
  waitForMessages: (n: number) => Promise<void>;
  sentTurns: () => string[];
  optionsLog: () => Record<string, unknown>[];
  queryFn: (args: SdkQueryArgs) => SdkQuery;
}

function makeHarness(): Harness {
  const consumed: SdkMessage[] = [];
  let deliver: ((m: SdkMessage) => void) | undefined;
  let interruptCount = 0;
  let canUseTool: SdkCanUseTool | undefined;
  const sentTurns: string[] = [];
  const optionsLog: Record<string, unknown>[] = [];

  const queryFn = (args: SdkQueryArgs): SdkQuery => {
    optionsLog.push(args.options);
    canUseTool = args.options["canUseTool"] as SdkCanUseTool;
    const queue: SdkMessage[] = [];
    const waiters: Array<(r: IteratorResult<SdkMessage>) => void> = [];
    let closed = false;
    deliver = (m) => {
      consumed.push(m);
      const w = waiters.shift();
      if (w) w({ value: m, done: false });
      else queue.push(m);
    };
    // Drain the input channel in the background to see what the engine sends.
    void (async () => {
      for await (const um of args.prompt) sentTurns.push(um.message.content);
    })();
    return {
      async interrupt() {
        interruptCount++;
        // The real SDK does NOT close the stream on interrupt — it still emits a `result` for
        // the interrupted turn (proved in the 0A spike). Just record the call.
      },
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SdkMessage>> {
            const queued = queue.shift();
            if (queued !== undefined) return { value: queued, done: false };
            if (closed) return { value: undefined as unknown as SdkMessage, done: true };
            return new Promise<IteratorResult<SdkMessage>>((res) => waiters.push(res));
          },
        };
      },
    };
  };

  return {
    emitFromSdk: (m) => deliver!(m),
    interruptSpy: () => interruptCount,
    canUseTool: () => canUseTool,
    waitForMessages: async (n) => {
      for (let i = 0; i < 200 && consumed.length < n; i++) await tick();
    },
    sentTurns: () => sentTurns,
    optionsLog: () => optionsLog,
    queryFn,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}

async function connect(h: Harness, ws = "E:/tmp/eng"): Promise<{ engine: ClaudeAgentEngine; events: EngineEvent[]; perms: EnginePermissionRequest[] }> {
  const engine = new ClaudeAgentEngine({ queryFn: h.queryFn });
  const events: EngineEvent[] = [];
  const perms: EnginePermissionRequest[] = [];
  engine.onEvent((e) => events.push(e));
  engine.onPermissionRequest((p) => perms.push(p));
  await engine.connect({ workspaceRoot: ws });
  return { engine, events, perms };
}

describe("ClaudeAgentEngine — SDK → IAgentEngine mapping", () => {
  it("captures session_id from system/init as the checkpoint", async () => {
    const h = makeHarness();
    const { engine } = await connect(h);
    h.emitFromSdk({ type: "system", subtype: "init", session_id: "sess-abc" });
    await drain();
    expect(engine.currentCheckpoint()).toEqual({ checkpointId: "sess-abc" });
  });

  it("streams text_delta as assistant_delta and finalizes assistant text as assistant_message", async () => {
    const h = makeHarness();
    const { engine, events } = await connect(h);
    h.emitFromSdk({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi " } } });
    h.emitFromSdk({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "there" } } });
    h.emitFromSdk({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] } });
    await drain();
    expect(events.filter((e) => e.type === "assistant_delta")).toHaveLength(2);
    expect(events.find((e) => e.type === "assistant_message")).toMatchObject({ text: "Hi there" });
    void engine;
  });

  it("canUseTool → permission_request; approveTool resolves with allow + updatedInput", async () => {
    const h = makeHarness();
    const { engine, perms } = await connect(h);
    const canUse = h.canUseTool()!;
    const promise = canUse("Write", { file_path: "/ws/hi.txt", content: "hello" }, { toolUseID: "tu-1" });
    await drain();
    expect(perms).toHaveLength(1);
    expect(perms[0]).toMatchObject({ requestId: "tu-1", toolName: "Write", diffPath: expect.any(String), diffUnified: expect.stringContaining("+hello") });
    await engine.approveTool("tu-1");
    await expect(promise).resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "/ws/hi.txt", content: "hello" } });
  });

  it("denyTool resolves canUseTool with behavior: deny", async () => {
    const h = makeHarness();
    const { engine, perms } = await connect(h);
    const promise = h.canUseTool()!("Bash", { command: "rm -rf /" }, { toolUseID: "tu-x" });
    await drain();
    expect(perms).toHaveLength(1);
    await engine.denyTool("tu-x");
    const r = await promise;
    expect(r.behavior).toBe("deny");
  });

  it("maps assistant tool_use to tool_use event, and user tool_result to tool_stream + tool_result", async () => {
    const h = makeHarness();
    const { events } = await connect(h);
    h.emitFromSdk({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] } });
    h.emitFromSdk({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "one\ntwo\n", is_error: false }] } });
    await drain();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_use", toolId: "toolu_1", name: "Bash" }),
      expect.objectContaining({ type: "tool_stream", toolId: "toolu_1", chunk: expect.stringContaining("one\ntwo") }),
      expect.objectContaining({ type: "tool_result", toolId: "toolu_1", ok: true }),
    ]));
  });

  it("result:success → turn_complete:ok; result:error → turn_complete:error", async () => {
    const h = makeHarness();
    const { events } = await connect(h);
    h.emitFromSdk({ type: "result", subtype: "success" });
    await drain();
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "turn_complete", status: "ok" }));
    h.emitFromSdk({ type: "result", subtype: "error_during_execution" });
    await drain();
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "turn_complete", status: "error", message: "error_during_execution" }));
  });

  it("interrupt() forwards to the SDK, denies pending permissions, and maps the next result to interrupted", async () => {
    const h = makeHarness();
    const { engine, events } = await connect(h);
    const canUse = h.canUseTool()!;
    const pending = canUse("Bash", { command: "sleep 10" }, { toolUseID: "tu-int" });
    await drain();
    await engine.interrupt();
    await expect(pending).resolves.toEqual(expect.objectContaining({ behavior: "deny" }));
    expect(h.interruptSpy()).toBe(1);
    h.emitFromSdk({ type: "result", subtype: "error_during_execution" });
    await drain();
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "turn_complete", status: "interrupted" }));
  });

  it("send(text) pushes a user message into the SDK prompt channel", async () => {
    const h = makeHarness();
    const { engine } = await connect(h);
    await engine.send("first");
    await engine.send("second");
    await drain();
    expect(h.sentTurns()).toEqual(["first", "second"]);
  });

  it("passes model + effort from constructor options into the initial SDK query", async () => {
    const h = makeHarness();
    const engine = new ClaudeAgentEngine({ queryFn: h.queryFn, model: "claude-opus-4-8", effort: "high" });
    await engine.connect({ workspaceRoot: "E:/tmp/eng" });
    expect(h.optionsLog()[0]).toMatchObject({ model: "claude-opus-4-8", effort: "high" });
  });

  it("configure(model, effort) applies to the next turn by restarting the query, preserving resume + context", async () => {
    const h = makeHarness();
    const { engine } = await connect(h);
    h.emitFromSdk({ type: "system", subtype: "init", session_id: "sess-1" });
    await drain();
    expect(h.optionsLog()).toHaveLength(1); // still on the original query

    await engine.configure({ model: "claude-sonnet-5", effort: "xhigh" });
    await engine.send("go");
    await drain();

    expect(h.optionsLog()).toHaveLength(2); // configure took effect on the next send → query restarted
    expect(h.optionsLog()[1]).toMatchObject({ model: "claude-sonnet-5", effort: "xhigh", resume: "sess-1" });
    expect(h.sentTurns()).toContain("go"); // the message was delivered on the new query
  });

  it("configure with only effort leaves the model unchanged", async () => {
    const h = makeHarness();
    const engine = new ClaudeAgentEngine({ queryFn: h.queryFn, model: "claude-opus-4-8" });
    await engine.connect({ workspaceRoot: "E:/tmp/eng" });
    await engine.configure({ effort: "low" });
    await engine.send("hi");
    await drain();
    expect(h.optionsLog()[1]).toMatchObject({ model: "claude-opus-4-8", effort: "low" });
  });

  it("resumeConversation restarts the SDK query with resume=checkpoint and remembers it", async () => {
    const h = makeHarness();
    const { engine } = await connect(h);
    const before = h.canUseTool();
    const restarted = await engine.resumeConversation({ checkpointId: "sess-prior" });
    // A new canUseTool instance means startQuery ran again
    expect(h.canUseTool()).not.toBe(before);
    expect(restarted.checkpointId).toBe("sess-prior");
    expect(engine.currentCheckpoint()?.checkpointId).toBe("sess-prior");
  });
});
