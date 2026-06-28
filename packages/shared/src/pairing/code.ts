/**
 * Pairing codes (D1 / ISSUES #11). One-shot, TTL-bounded codes shown on the trusted daemon machine,
 * typed into the browser to bootstrap browser-key enrollment. Crockford base32: dense (5 bits/char),
 * unambiguous (no I, L, O, U), case-insensitive — friendly to read off a screen and type on a phone.
 *
 * 10 chars * 5 bits = 50 bits of entropy: with one-shot consumption + 5-min TTL + (Phase 2) rate
 * limiting, far above brute-force feasibility for the active window. 256 % 32 == 0, so masking a
 * random byte with 0x1f introduces NO modular bias.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALPHABET_SET = new Set(ALPHABET);

const CODE_LEN = 10;

/** Generate a fresh 10-char Crockford-base32 pairing code. */
export function generateCode(): string {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) throw new Error("WebCrypto getRandomValues is required");
  const bytes = new Uint8Array(CODE_LEN);
  c.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i]! & 0x1f];
  return out;
}

/**
 * Normalize user-typed code: uppercase, strip whitespace/dashes, map ambiguous I/L→1, O→0.
 * Returns the 10-char canonical form, or undefined if the input isn't a valid code.
 */
export function normalizeCode(input: string): string | undefined {
  if (typeof input !== "string") return undefined;
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length !== CODE_LEN) return undefined;
  for (const c of cleaned) {
    if (!ALPHABET_SET.has(c)) return undefined;
  }
  return cleaned;
}

/** Human-friendly display: XXXX-XXXX-XX. */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  if (!c) throw new Error("formatCode: invalid code");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 10)}`;
}
