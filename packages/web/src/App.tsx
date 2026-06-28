import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecutionMode, PermissionDecision, PermissionScope } from "@wcc/shared";
import { loadConfig } from "./config.js";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { Connection, type ConnectionStatus } from "./protocol-client.js";
import { SessionModel, type SessionView } from "./session-model.js";
import { StatusBar } from "./ui/StatusBar.js";
import { Transcript } from "./ui/Transcript.js";
import { PermissionPrompt } from "./ui/PermissionPrompt.js";
import { Composer } from "./ui/Composer.js";

const EMPTY_VIEW: SessionView = { items: [], state: "idle" };

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [view, setView] = useState<SessionView>(EMPTY_VIEW);
  const modelRef = useRef<SessionModel | null>(null);
  const connRef = useRef<Connection | null>(null);

  useEffect(() => {
    let cancelled = false;
    let conn: Connection | null = null;
    const model = new SessionModel();
    modelRef.current = model;

    void (async () => {
      const id = await loadOrCreateIdentity();
      if (cancelled) return;
      setIdentity(id);
      const cfg = loadConfig();
      conn = new Connection({
        url: cfg.relayUrl,
        token: cfg.token,
        deviceId: cfg.deviceId,
        sessionId: cfg.sessionId,
        clientInstanceId: id.clientInstanceId,
        secretKey: id.secretKey,
        onEvent: (e) => {
          model.apply(e);
          setView(model.view());
        },
        onStatus: setStatus,
      });
      connRef.current = conn;
      conn.connect();
    })();

    return () => {
      cancelled = true;
      conn?.close();
    };
  }, []);

  const sendMessage = useCallback((text: string) => {
    const model = modelRef.current;
    const conn = connRef.current;
    if (!model || !conn) return;
    model.addLocalUserMessage(text);
    setView(model.view());
    void conn.send({ type: "user_message", text });
  }, []);

  const decide = useCallback(
    (requestId: string, decision: PermissionDecision, scope?: PermissionScope) => {
      const model = modelRef.current;
      const conn = connRef.current;
      if (!model || !conn) return;
      model.clearPending();
      setView(model.view());
      void conn.send({ type: "permission_response", requestId, decision, ...(scope ? { scope } : {}) });
    },
    [],
  );

  const interrupt = useCallback(() => {
    void connRef.current?.send({ type: "interrupt" });
  }, []);

  const setMode = useCallback((executionMode: ExecutionMode) => {
    void connRef.current?.send({ type: "policy_update", executionMode });
  }, []);

  const busy =
    view.state === "thinking" || view.state === "tool-running" || view.state === "awaiting-approval";

  return (
    <div className="app">
      <StatusBar status={status} view={view} identity={identity} onMode={setMode} />
      <Transcript items={view.items} />
      {view.pending && <PermissionPrompt pending={view.pending} onDecide={decide} />}
      <Composer onSend={sendMessage} canSend={status === "ready"} busy={busy} onInterrupt={interrupt} />
    </div>
  );
}
