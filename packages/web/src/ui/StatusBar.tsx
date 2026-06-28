import { useState } from "react";
import type { ExecutionMode } from "@wcc/shared";
import type { SessionView } from "../session-model.js";
import type { ConnectionStatus } from "../protocol-client.js";
import type { Identity } from "../identity.js";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "connecting…",
  registered: "registered",
  ready: "connected",
  "daemon-offline": "machine offline",
  closed: "disconnected",
  error: "error",
};

const STATE_LABEL: Record<string, string> = {
  idle: "idle",
  thinking: "thinking…",
  "tool-running": "running tool…",
  "awaiting-approval": "awaiting approval",
  ended: "session ended",
};

const MODES: ExecutionMode[] = ["manual", "auto-edits", "yolo"];

/** Header: connection health, session state, execution-mode selector, and the pairing public key. */
export function StatusBar({
  status,
  view,
  identity,
  onMode,
}: {
  status: ConnectionStatus;
  view: SessionView;
  identity: Identity | null;
  onMode: (mode: ExecutionMode) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const online = status === "ready";

  return (
    <header className="statusbar">
      <div className="brand">
        ClaudeBridge<span className="brand-sub">web · your machine</span>
      </div>
      <div className="status-meta">
        <span className={`dot ${online ? "on" : status === "daemon-offline" ? "warn" : "off"}`} />
        <span className="status-text">{STATUS_LABEL[status]}</span>
        <span className="sep">·</span>
        <span className="session-state">{STATE_LABEL[view.state] ?? view.state}</span>
        {view.workspaceId && <span className="workspace">@{view.workspaceId}</span>}
      </div>
      <div className="status-controls">
        <label className="mode">
          mode
          <select value={view.executionMode ?? "manual"} onChange={(e) => onMode(e.target.value as ExecutionMode)}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button className="link" onClick={() => setShowKey((v) => !v)} title="Pair this browser with your daemon">
          {showKey ? "hide key" : "pairing key"}
        </button>
      </div>
      {showKey && identity && (
        <div className="pairing">
          <div className="pairing-label">Paste into your daemon as <code>WCC_PAIRED_PUBKEY</code>:</div>
          <code className="pairing-key">{identity.publicKeyB64}</code>
        </div>
      )}
    </header>
  );
}
