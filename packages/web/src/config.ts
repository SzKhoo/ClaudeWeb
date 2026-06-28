/**
 * App config from Vite env vars (with dev defaults matching the daemon/relay dev defaults), so the
 * slice runs out-of-the-box: relay on :8787, shared dev token, deviceId/sessionId = "dev-*".
 */
export interface AppConfig {
  relayUrl: string;
  token: string;
  deviceId: string;
  sessionId: string;
}

export function loadConfig(): AppConfig {
  const env = import.meta.env;
  return {
    relayUrl: env.VITE_RELAY_URL ?? "ws://localhost:8787",
    token: env.VITE_RELAY_TOKEN ?? "dev-relay-token",
    deviceId: env.VITE_DEVICE_ID ?? "dev-device",
    sessionId: env.VITE_SESSION_ID ?? "dev-session",
  };
}
