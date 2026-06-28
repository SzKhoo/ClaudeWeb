/**
 * Minimal ambient typings for the WebCrypto names we touch. Node 20+ exposes these on `globalThis`
 * (via `node:crypto.webcrypto`), and the browser exposes them natively. The repo's root tsconfig uses
 * `lib: ["ES2022"]` (no DOM) to keep Node-side code clean, but we still need the type names. This
 * file is intentionally narrow — only what we call.
 */

export {};

declare global {
  type KeyUsage =
    | "encrypt"
    | "decrypt"
    | "sign"
    | "verify"
    | "deriveKey"
    | "deriveBits"
    | "wrapKey"
    | "unwrapKey";

  interface CryptoKey {
    readonly algorithm: { name: string; [k: string]: unknown };
    readonly extractable: boolean;
    readonly type: "secret" | "private" | "public";
    readonly usages: KeyUsage[];
  }

  interface SubtleCrypto {
    digest(algorithm: string | { name: string }, data: ArrayBuffer): Promise<ArrayBuffer>;
    importKey(
      format: "raw",
      keyData: ArrayBuffer,
      algorithm: string | { name: string; hash?: string },
      extractable: boolean,
      usages: KeyUsage[],
    ): Promise<CryptoKey>;
    deriveBits(
      algorithm: { name: string; hash: string; salt: ArrayBuffer; info: ArrayBuffer },
      baseKey: CryptoKey,
      length: number,
    ): Promise<ArrayBuffer>;
    sign(
      algorithm: string | { name: string },
      key: CryptoKey,
      data: ArrayBuffer,
    ): Promise<ArrayBuffer>;
    verify(
      algorithm: string | { name: string },
      key: CryptoKey,
      signature: ArrayBuffer,
      data: ArrayBuffer,
    ): Promise<boolean>;
  }

  interface Crypto {
    readonly subtle: SubtleCrypto;
    getRandomValues<T extends ArrayBufferView | null>(array: T): T;
    randomUUID?(): string;
  }
}
