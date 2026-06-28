/**
 * S1.5 pairing flow: drives the browser-side startPairing() against an in-process EnrollmentManager
 * via a synthetic PairingTransport. Proves the happy path + the relay-impersonation defence + a
 * directory-miss rejection.
 */
import { describe, expect, it } from "vitest";
import {
  generateKeyPair,
  toBase64Url,
  type KeyPair,
} from "@wcc/shared";
import {
  PairingError,
  startPairing,
  type PairingDirectory,
  type PairingStorage,
  type PairingTransport,
} from "../src/pairing-flow.js";
import { EnrolledKeyStore } from "../../daemon/src/security/EnrolledKeyStore.js";
import { EnrollmentManager } from "../../daemon/src/security/EnrollmentManager.js";
import { PairingCodeStore } from "../../daemon/src/security/PairingCodeStore.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEVICE_ID = "dev-A";

interface Ctx {
  tmpDir: string;
  device: KeyPair;
  manager: EnrollmentManager;
  transport: PairingTransport;
  /** Dispatch a frame the browser sent through the manager + relay back the ack. */
}

async function setupCtx(): Promise<Ctx> {
  const tmpDir = mkdtempSync(join(tmpdir(), "wcc-pf-"));
  const store = await EnrolledKeyStore.open(join(tmpDir, "keys.json"));
  const codes = new PairingCodeStore();
  const device = await generateKeyPair();
  let n = 0;
  const manager = new EnrollmentManager({
    deviceId: DEVICE_ID,
    enrolledKeys: store,
    codes,
    deviceSecretKey: device.secretKey,
    devicePubKey: device.publicKey,
    newKeyId: () => `k-${++n}`,
  });
  // Wire a synthetic transport: browser.send → manager.handle → emit ack via onFrame handlers.
  const handlers = new Set<(f: unknown) => void>();
  const transport: PairingTransport = {
    send: async (frame: unknown) => {
      const ack = await manager.handle(frame);
      // dispatch on next microtask to better mimic real WS
      queueMicrotask(() => handlers.forEach((h) => h(ack)));
    },
    onFrame: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
  return { tmpDir, device, manager, transport };
}

function inMemoryDirectory(pubkey: Uint8Array | undefined): PairingDirectory {
  return {
    async devicePubKey(_id: string) {
      return pubkey;
    },
  };
}

function memStorage(): PairingStorage {
  let map: Record<string, unknown> = {};
  return {
    load: () => ({ ...(map as Record<string, never>) }),
    save: (m) => {
      map = m;
    },
  };
}

describe("startPairing", () => {
  it("happy path: code + correct directory → resolves with keyId; pairing stored", async () => {
    const ctx = await setupCtx();
    try {
      const code = ctx.manager.mintCode("phone");
      const browser = await generateKeyPair();
      const storage = memStorage();
      const result = await startPairing({
        deviceId: DEVICE_ID,
        code,
        browserPubKey: browser.publicKey,
        transport: ctx.transport,
        directory: inMemoryDirectory(ctx.device.publicKey),
        storage,
        timeoutMs: 2000,
      });
      expect(result.keyId).toBe("k-1");
      expect(result.devicePubKey).toBe(toBase64Url(ctx.device.publicKey));
      expect(storage.load()[DEVICE_ID]).toMatchObject({ keyId: "k-1" });
    } finally {
      rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects with device_pubkey_mismatch when the directory says a DIFFERENT pubkey", async () => {
    const ctx = await setupCtx();
    try {
      const code = ctx.manager.mintCode();
      const browser = await generateKeyPair();
      const impostor = await generateKeyPair();
      // The directory mistakenly returns the impostor's pubkey (or relay swapped it).
      await expect(
        startPairing({
          deviceId: DEVICE_ID,
          code,
          browserPubKey: browser.publicKey,
          transport: ctx.transport,
          directory: inMemoryDirectory(impostor.publicKey),
          storage: null,
          timeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ reason: "device_pubkey_mismatch" });
    } finally {
      rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects with directory_miss when the directory has no entry for the device", async () => {
    const ctx = await setupCtx();
    try {
      const code = ctx.manager.mintCode();
      const browser = await generateKeyPair();
      await expect(
        startPairing({
          deviceId: DEVICE_ID,
          code,
          browserPubKey: browser.publicKey,
          transport: ctx.transport,
          directory: inMemoryDirectory(undefined),
          storage: null,
          timeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ reason: "directory_miss" });
    } finally {
      rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects with bad_code on a wrong code", async () => {
    const ctx = await setupCtx();
    try {
      ctx.manager.mintCode();
      const browser = await generateKeyPair();
      await expect(
        startPairing({
          deviceId: DEVICE_ID,
          code: "ZZZZ-ZZZZ-ZZ",
          browserPubKey: browser.publicKey,
          transport: ctx.transport,
          directory: inMemoryDirectory(ctx.device.publicKey),
          storage: null,
          timeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ reason: "bad_code" });
    } finally {
      rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  it("PairingError instances expose .reason", async () => {
    const e = new PairingError("timeout", "x");
    expect(e.reason).toBe("timeout");
    expect(e.name).toBe("PairingError");
  });
});
