/**
 * Test helpers shared across the daemon suite (NOT a *.test.ts, so vitest won't run it directly).
 * Keeps temp workspaces on E: (per the "everything on E:" constraint) and provides small async
 * utilities for driving the MockEngine's setTimeout(0)-paced turns deterministically.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  newEnvelope,
  signed,
  generateKeyPair,
  type ApplicationCommand,
  type KeyPair,
  type TransportEnvelope,
} from "@wcc/shared";

const TEST_TMP_BASE = process.env["WCC_TEST_TMP"] ?? "E:\\StorageContent\\tmp\\wcc-tests";

/** Create a unique temp workspace directory on E:. Returns its absolute path. */
export function makeTempWorkspace(): string {
  mkdirSync(TEST_TMP_BASE, { recursive: true });
  return mkdtempSync(join(TEST_TMP_BASE, "ws-"));
}

/** Recursively remove a temp workspace; ignores errors. */
export function cleanupWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function fileExists(dir: string, rel: string): boolean {
  return existsSync(join(dir, rel));
}

export function readWorkspaceFile(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

/** Yield to the macrotask queue `n` times — lets MockEngine's setTimeout(0) chain advance. */
export async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

/** Poll `predicate` (flushing between checks) until true or it times out. */
export async function waitUntil(predicate: () => boolean, attempts = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await new Promise<void>((r) => setTimeout(r, 1));
  }
  return predicate();
}

/** A browser-side signing identity for building signed command envelopes in tests. */
export interface TestBrowser {
  keys: KeyPair;
  deviceId: string;
  sessionId: string;
  clientInstanceId: string;
  seq: number;
}

export async function makeTestBrowser(over: Partial<Omit<TestBrowser, "keys" | "seq">> = {}): Promise<TestBrowser> {
  return {
    keys: await generateKeyPair(),
    deviceId: over.deviceId ?? "dev-device",
    sessionId: over.sessionId ?? "dev-session",
    clientInstanceId: over.clientInstanceId ?? "browser-1",
    seq: 0,
  };
}

/** Build a signed command envelope from a TestBrowser, advancing its monotonic seq. */
export async function signCommand(
  browser: TestBrowser,
  command: ApplicationCommand,
  opts: { seq?: number; timestamp?: number } = {},
): Promise<TransportEnvelope> {
  const seq = opts.seq ?? ++browser.seq;
  const env = newEnvelope({
    protocolVersion: "1.0.0",
    deviceId: browser.deviceId,
    sessionId: browser.sessionId,
    clientInstanceId: browser.clientInstanceId,
    seq,
    payload: command,
    ...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  });
  return signed(env, browser.keys.secretKey);
}
