import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApplicationEvent,
  Attachment,
  EffortLevel,
  ExecutionMode,
  PermissionDecision,
  PermissionScope,
} from "@wcc/shared";
import { loadConfig } from "./config.js";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { Connection, type ConnectionStatus } from "./protocol-client.js";
import { SessionModel, type SessionView } from "./session-model.js";
import { downloadBase64, randomId } from "./attachments.js";
import { useTheme } from "./theme.js";
import { Toolbar } from "./ui/Toolbar.js";
import { Sidebar } from "./ui/Sidebar.js";
import { Transcript } from "./ui/Transcript.js";
import { PermissionPrompt } from "./ui/PermissionPrompt.js";
import { Composer } from "./ui/Composer.js";
import { Phase1Shell } from "./Phase1Shell.js";

const EMPTY_VIEW: SessionView = {
  items: [],
  state: "idle",
  sessions: [],
  activeSessionId: null,
  displayedSessionId: null,
  displayedItems: null,
};

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

export function App() {
  // Phase 1 multi-tenant shell: opt-in via ?phase=1 (URL query). Default = Phase 0 single-tenant path
  // so the existing live demo / e2e tests keep working without surgery.
  const isPhase1 =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("phase");
  if (isPhase1) return <Phase1Shell />;
  return <Phase0App />;
}

function Phase0App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [view, setView] = useState<SessionView>(EMPTY_VIEW);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();
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
    })();

    return () => {
      cancelled = true;
      conn?.close();
    };
  }, []);

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

  const setConfig = useCallback((config: { model?: string; effort?: EffortLevel }) => {
    // An empty-string model/effort is the explicit "reset to the daemon's default" signal (the engine
    // treats it as falsy). Absent fields are left unchanged by the daemon.
    void connRef.current?.send({ type: "session_config", ...config });
  }, []);

  const busy =
    view.state === "thinking" || view.state === "tool-running" || view.state === "awaiting-approval";

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
        identity={identity}
        machine={view.machine}
        theme={theme}
        onToggleTheme={toggleTheme}
        sessions={view.sessions}
        activeSessionId={view.activeSessionId}
        displayedSessionId={view.displayedSessionId}
        onNewSession={() => connRef.current?.send({ type: "new_session" })}
        onOpenSession={(id) => connRef.current?.send({ type: "get_session_journal", sessionId: id })}
        onRenameSession={(id, title) =>
          connRef.current?.send({ type: "rename_session", sessionId: id, title })
        }
        onDeleteSession={(id) => connRef.current?.send({ type: "delete_session", sessionId: id })}
      />
      <Transcript items={view.items} onDownload={requestFile} onDownloadBundle={requestBundle} />
      {view.pending && <PermissionPrompt pending={view.pending} onDecide={decide} />}
      <Composer onSend={sendMessage} canSend={status === "ready"} busy={busy} onInterrupt={interrupt} />
    </div>
  );
}
