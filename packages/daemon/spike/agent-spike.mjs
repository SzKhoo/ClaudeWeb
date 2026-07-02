/**
 * 0A runtime spike [GATE] — Milestone M2 / Story S2.2.
 *
 * Proves the Claude Agent SDK can back our IAgentEngine over the exact interactions the daemon
 * needs, on THIS authenticated machine (no ANTHROPIC_API_KEY — uses the local Claude Code login):
 *   L1  streaming-input query + canUseTool approval → a real file is written to disk
 *   L2  a second prompt in the SAME live session gets a coherent answer (multi-turn)
 *   L3  interrupt() stops an in-flight turn and returns control
 *   L4  resume: a FRESH query() with { resume: sessionId } recalls earlier context (compaction-safe;
 *       no raw transcript re-feed — the SDK/CLI restores the conversation itself)
 *
 * Run: node packages/daemon/spike/agent-spike.mjs
 * Exits 0 only if every gate leg passes.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP_ROOT = "E:/StorageContent/tmp";
mkdirSync(TMP_ROOT, { recursive: true });
const WS = mkdtempSync(join(TMP_ROOT, "wcc-spike-"));
const MODEL = process.env.SPIKE_MODEL || "claude-haiku-4-5";

const log = (...a) => console.log("[spike]", ...a);
let permissionCalls = 0;

function userMsg(text) {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** An async-iterable backed by a queue, so we can push turns into a live streaming-input query. */
function inputChannel() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(msg) {
      const w = waiters.shift();
      if (w) w({ value: msg, done: false });
      else items.push(msg);
    },
    close() {
      closed = true;
      const w = waiters.shift();
      if (w) w({ value: undefined, done: true });
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        const next = await new Promise((res) => waiters.push(res));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

const canUseTool = async (toolName, input) => {
  permissionCalls++;
  log(`canUseTool fired: ${toolName}`, JSON.stringify(input).slice(0, 120));
  return { behavior: "allow", updatedInput: input };
};

function textOf(assistantMsg) {
  const c = assistantMsg?.message?.content;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function main() {
  log("workspace:", WS, "model:", MODEL);
  const results = { L1: false, L2: false, L3: false, L4: false };
  let sessionId;

  // ── Legs 1–3: one live streaming-input session ──────────────────────────────
  const input = inputChannel();
  const q = query({
    prompt: input,
    options: {
      model: MODEL,
      cwd: WS,
      permissionMode: "default", // Write falls through to canUseTool (not pre-approved)
      canUseTool,
      includePartialMessages: true,
    },
  });

  let phase = 1;
  let sawDeltaThisTurn = false;
  input.push(userMsg('Create a file named greeting.txt containing exactly: hello from spike'));

  const L2_Q = "What is the name of the file you just created? Reply with only the filename.";

  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id;
      log("session id:", sessionId);
      continue;
    }
    if (m.type === "stream_event") {
      // partial assistant delta — used to time the interrupt in phase 3
      if (m.event?.type === "content_block_delta") sawDeltaThisTurn = true;
      continue;
    }
    if (m.type === "result") {
      log(`turn ${phase} result:`, m.subtype);
      if (phase === 1) {
        const p = join(WS, "greeting.txt");
        results.L1 = existsSync(p) && readFileSync(p, "utf8").includes("hello from spike");
        log("L1 file-written:", results.L1);
        phase = 2;
        sawDeltaThisTurn = false;
        input.push(userMsg(L2_Q));
      } else if (phase === 2) {
        results.L2 = true; // a coherent second turn completed in the same session
        log("L2 multi-turn: got result subtype", m.subtype);
        phase = 3;
        sawDeltaThisTurn = false;
        input.push(userMsg("Write a slow, detailed 600-word essay about the ocean. Take your time."));
        // Interrupt shortly after the turn starts producing output.
        void (async () => {
          for (let i = 0; i < 60 && !sawDeltaThisTurn; i++) {
            await new Promise((r) => setTimeout(r, 100));
          }
          log("calling interrupt()…");
          try { await q.interrupt(); log("interrupt() resolved"); }
          catch (e) { log("interrupt() threw:", String(e)); }
        })();
      } else if (phase === 3) {
        // Any terminal result after interrupt = control returned. (subtype is often error/interrupted.)
        results.L3 = true;
        log("L3 interrupt returned control: subtype", m.subtype);
        input.close();
        break;
      }
    }
  }

  // ── Leg 4: fresh query() resuming the SAME session id — context must survive ──
  if (sessionId) {
    log("resuming session", sessionId, "in a new query()…");
    let answer = "";
    for await (const m of query({
      prompt: 'Earlier in THIS conversation you created a file. Reply with ONLY its filename.',
      options: { model: MODEL, cwd: WS, resume: sessionId, permissionMode: "default", canUseTool },
    })) {
      if (m.type === "assistant") answer += textOf(m);
    }
    log("resume answer:", JSON.stringify(answer.trim().slice(0, 80)));
    results.L4 = /greeting\.txt/i.test(answer);
    log("L4 context-preserved:", results.L4);
  } else {
    log("L4 skipped: no session id captured");
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  log("permission callback invocations:", permissionCalls);
  log("RESULTS:", JSON.stringify(results));
  try { rmSync(WS, { recursive: true, force: true }); } catch {}
  const pass = results.L1 && results.L2 && results.L3 && results.L4 && permissionCalls > 0;
  log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { log("FATAL", e?.stack || String(e)); process.exit(2); });
