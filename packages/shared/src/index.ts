/**
 * @wcc/shared — the protocol + crypto + engine-contract layer shared by daemon, relay and web.
 * Single source of truth for what goes on the wire. Consumed via the `@wcc/shared` alias (no
 * node_modules symlink — exFAT forbids them).
 */
export * from "./protocol/version.js";
export * from "./protocol/envelope.js";
export * from "./protocol/messages.js";
export * from "./protocol/canonical.js";
export * from "./protocol/sign.js";
export * from "./engine/IAgentEngine.js";
export * from "./pairing/code.js";
export * from "./pairing/hkdf.js";
export * from "./pairing/pairing.js";
export * from "./pairing/jwt.js";
