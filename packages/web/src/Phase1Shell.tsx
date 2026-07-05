/**
 * Phase 1 shell: auth (mock for now, Supabase at S1.6) → device picker → pair-if-needed → live session.
 * The actual live-session UI is the same code as Phase 0 (reuses Connection + SessionModel + UI);
 * what differs is the path we took to get there + the credentials we hand to the relay.
 *
 * Defaults in dev are deliberately matched to the relay+daemon dev defaults so a developer can flip
 * `?phase=1` and get to a working pairing dialog without env wrangling.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApplicationEvent,
  Attachment,
  EffortLevel,
  ExecutionMode,
  PermissionDecision,
  PermissionScope,
} from "@wcc/shared";
import { fromBase64Url } from "@wcc/shared";
import { downloadBase64, randomId } from "./attachments.js";
import {
  MockAuthClient,
  type AuthClient,
  type AuthSession,
  type AuthState,
} from "./auth-client.js";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { Connection, type ConnectionStatus } from "./protocol-client.js";
import { SessionModel, type SessionView } from "./session-model.js";
import { LoginScreen } from "./ui/LoginScreen.js";
import { PairingScreen } from "./ui/PairingScreen.js";
import { Toolbar } from "./ui/Toolbar.js";
import { Sidebar } from "./ui/Sidebar.js";
import { Transcript } from "./ui/Transcript.js";
import { PermissionPrompt } from "./ui/PermissionPrompt.js";
import { Composer } from "./ui/Composer.js";
import { useTheme } from "./theme.js";
import {
  getPairing,
  isAlreadyPaired,
  startPairing,
  type PairingDirectory,
  type PairingTransport,
} from "./pairing-flow.js";

const EMPTY_VIEW: SessionView = { items: [], state: "idle" };

/** A file_data reply: trigger a browser download on success, or surface the error in the transcript. */
function handleFileData(
  model: SessionModel,
  e: Extract<ApplicationEvent, { type: "file_data" }>,
): void {
  if (e.data !== undefined) {
    downloadBase64(e.name, e.mediaType, e.data);
    model.apply({
      type: "system_message",
      level: "info",
      text: `Downloaded ${e.name}${e.truncated ? " (truncated — file exceeded the transfer cap)" : ""}.`,
    });
  } else {
    model.apply({ type: "system_message", level: "error", text: e.error ?? `Could not download ${e.path}.` });
  }
}

const DEV_JWT_SECRET = new TextEncoder().encode(
  // Matches the daemon/relay dev secret if you set RELAY_JWT_SECRET; safe ONLY for local dev.
  (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_DEV_JWT_SECRET) ||
    "phase-1-dev-jwt-secret-32-bytes!",
);

// Default mock auth user — wired to the directory device below.
const DEV_AUTH = new MockAuthClient({
  jwtSecret: DEV_JWT_SECRET,
  users: {
    "alice@example.com": { userId: "alice", password: "alice-pw" },
    "bob@example.com": { userId: "bob", password: "bob-pw" },
  },
});

// Dev directory: who-owns-what + each device's expected pubkey (learned out-of-band from Supabase
// in prod; here we read it from VITE_DEV_DEVICE_PUBKEY or expect the operator to wire it).
function devDirectory(devicePubKeyB64: string | undefined): PairingDirectory {
  return {
    async devicePubKey(_deviceId: string): Promise<Uint8Array | undefined> {
      if (!devicePubKeyB64) return undefined;
      try {
        return fromBase64Url(devicePubKeyB64);
      } catch {
        return undefined;
      }
    },
  };
}

interface DevSettings {
  deviceId: string;
  sessionId: string;
  relayUrl: string;
  devicePubKeyB64?: string;
}

function loadDevSettings(): DevSettings {
  const env = (import.meta as { env?: Record<string, string> }).env ?? {};
  return {
    deviceId: env["VITE_DEVICE_ID"] ?? "dev-device",
    sessionId: env["VITE_SESSION_ID"] ?? "dev-session",
    relayUrl: env["VITE_RELAY_URL"] ?? "ws://localhost:8787",
    devicePubKeyB64: env["VITE_DEV_DEVICE_PUBKEY"],
  };
}

type ShellState =
  | { phase: "loading" }
  | { phase: "login" }
  | { phase: "pairing"; session: AuthSession; identity: Identity }
  | { phase: "live"; session: AuthSession; identity: Identity };

export function Phase1Shell({ auth = DEV_AUTH }: { auth?: AuthClient } = {}) {
  const [state, setState] = useState<ShellState>({ phase: "loading" });
  const identityRef = useRef<Identity | null>(null);
  const settings = useRef<DevSettings>(loadDevSettings()).current;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = await loadOrCreateIdentity();
      if (cancelled) return;
      identityRef.current = id;
      const auth0: AuthState = auth.current();
      if (auth0.status === "signed-in") {
        const paired = isAlreadyPaired(settings.deviceId);
        setState({
          phase: paired ? "live" : "pairing",
          session: auth0.session,
          identity: id,
        });
      } else {
        setState({ phase: "login" });
      }
    })();
    const unsub = auth.subscribe((s) => {
      const id = identityRef.current;
      if (s.status === "signed-in" && id) {
        const paired = isAlreadyPaired(settings.deviceId);
        setState({
          phase: paired ? "live" : "pairing",
          session: s.session,
          identity: id,
        });
      } else if (s.status === "signed-out") {
        setState({ phase: "login" });
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [auth, settings.deviceId]);

  if (state.phase === "loading") return <div className="loading">Loading…</div>;
  if (state.phase === "login") return <LoginScreen auth={auth} onSignedIn={() => { /* state updates via subscribe */ }} />;
  if (state.phase === "pairing") return <PairingFlowScreen state={state} settings={settings} onLive={() => setState({ phase: "live", session: state.session, identity: state.identity })} />;
  return <LiveSession state={state} settings={settings} onSignOut={() => void auth.signOut()} />;
}

function PairingFlowScreen({
  state,
  settings,
  onLive,
}: {
  state: { phase: "pairing"; session: AuthSession; identity: Identity };
  settings: DevSettings;
  onLive: () => void;
}) {
  const onSubmit = useCallback(
    async (code: string) => {
      // Open a temporary WS to the relay, register as browser with the auth JWT, then send the bare
      // enroll_request frame and await the enroll_ack. We keep this self-contained so the live
      // session's Connection class doesn't need to grow a "pairing channel" concept.
      const ws = new WebSocket(settings.relayUrl);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws error")));
      });
      ws.send(
        JSON.stringify({
          type: "relay_register",
          token: state.session.accessToken,
          role: "browser",
          deviceId: settings.deviceId,
          clientInstanceId: state.identity.clientInstanceId,
        }),
      );
      const transport: PairingTransport = {
        send: (frame) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
        onFrame: (handler) => {
          const listener = (ev: MessageEvent<string>) => {
            try {
              handler(JSON.parse(String(ev.data)));
            } catch {
              /* ignore */
            }
          };
          ws.addEventListener("message", listener);
          return () => ws.removeEventListener("message", listener);
        },
      };
      try {
        const result = await startPairing({
          deviceId: settings.deviceId,
          code,
          browserPubKey: state.identity.publicKey,
          label: navigator.userAgent.split(" ")[0] ?? "browser",
          transport,
          directory: devDirectory(settings.devicePubKeyB64),
        });
        return result;
      } finally {
        ws.close();
      }
    },
    [state, settings],
  );

  return (
    <PairingScreen
      identity={state.identity}
      deviceId={settings.deviceId}
      onSubmit={onSubmit}
      onDone={onLive}
    />
  );
}

function LiveSession({
  state,
  settings,
  onSignOut,
}: {
  state: { phase: "live"; session: AuthSession; identity: Identity };
  settings: DevSettings;
  onSignOut: () => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [view, setView] = useState<SessionView>(EMPTY_VIEW);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();
  const modelRef = useRef<SessionModel | null>(null);
  const connRef = useRef<Connection | null>(null);

  useEffect(() => {
    const model = new SessionModel();
    modelRef.current = model;
    const conn = new Connection({
      url: settings.relayUrl,
      token: state.session.accessToken,
      deviceId: settings.deviceId,
      sessionId: settings.sessionId,
      clientInstanceId: state.identity.clientInstanceId,
      secretKey: state.identity.secretKey,
      onEvent: (e) => {
        if (e.type === "file_data") {
          handleFileData(model, e);
          setView(model.view());
          return;
        }
        model.apply(e);
        setView(model.view());
      },
      onStatus: setStatus,
    });
    connRef.current = conn;
    conn.connect();
    return () => conn.close();
  }, [state, settings]);

  const sendMessage = useCallback((text: string, attachments?: Attachment[]) => {
    const model = modelRef.current;
    const conn = connRef.current;
    if (!model || !conn) return;
    model.addLocalUserMessage(
      text,
      attachments?.map((a) => ({ name: a.name, mediaType: a.mediaType })),
    );
    setView(model.view());
    void conn.send({ type: "user_message", text, ...(attachments?.length ? { attachments } : {}) });
  }, []);

  const requestFile = useCallback((path: string) => {
    void connRef.current?.send({ type: "file_request", requestId: randomId(), path });
  }, []);

  const requestBundle = useCallback((paths: string[]) => {
    void connRef.current?.send({ type: "bundle_request", requestId: randomId(), paths });
  }, []);

  const decide = useCallback(
    (requestId: string, decision: PermissionDecision, scope?: PermissionScope) => {
      const model = modelRef.current;
      const conn = connRef.current;
      if (!model || !conn) return;
      model.clearPending();
      setView(model.view());
      void conn.send({
        type: "permission_response",
        requestId,
        decision,
        ...(scope ? { scope } : {}),
      });
    },
    [],
  );

  const interrupt = useCallback(() => {
    void connRef.current?.send({ type: "interrupt" });
  }, []);

  const setMode = useCallback((executionMode: ExecutionMode) => {
    void connRef.current?.send({ type: "policy_update", executionMode });
  }, []);

  const setConfig = useCallback((config: { model?: string; effort?: EffortLevel }) => {
    void connRef.current?.send({ type: "session_config", ...config });
  }, []);

  const busy =
    view.state === "thinking" || view.state === "tool-running" || view.state === "awaiting-approval";

  const pairing = getPairing(settings.deviceId);

  return (
    <div className="app">
      <Toolbar
        status={status}
        view={view}
        onMode={setMode}
        onConfig={setConfig}
        onOpenSidebar={() => setSidebarOpen(true)}
      />
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        identity={state.identity}
        machine={view.machine}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div className="phase-bar">
        Signed in as <code>{state.session.email ?? state.session.userId}</code> · device{" "}
        <code>{settings.deviceId}</code>
        {pairing && <> · keyId <code>{pairing.keyId}</code></>} ·{" "}
        <button className="link" onClick={onSignOut}>
          Sign out
        </button>
      </div>
      <Transcript items={view.items} onDownload={requestFile} onDownloadBundle={requestBundle} />
      {view.pending && <PermissionPrompt pending={view.pending} onDecide={decide} />}
      <Composer onSend={sendMessage} canSend={status === "ready"} busy={busy} onInterrupt={interrupt} />
    </div>
  );
}
