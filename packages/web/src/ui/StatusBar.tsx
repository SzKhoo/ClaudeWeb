import { useState } from "react";
import type { EffortLevel, ExecutionMode } from "@wcc/shared";
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

/** Selectable models. Empty id = leave the daemon's default (CLI-configured) model unchanged. */
const MODELS: Array<{ id: string; label: string }> = [
  { id: "", label: "model: default" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];
const EFFORTS: Array<{ id: string; label: string }> = [
  { id: "", label: "effort: default" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
  { id: "max", label: "max" },
];

/** Header: connection health, session state, model/effort + execution-mode selectors, pairing key. */
export function StatusBar({
  status,
  view,
  identity,
  onMode,
  onConfig,
}: {
  status: ConnectionStatus;
  view: SessionView;
  identity: Identity | null;
  onMode: (mode: ExecutionMode) => void;
  onConfig: (config: { model?: string; effort?: EffortLevel }) => void;
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
        <select
          className="picker"
          value={view.model ?? ""}
          title="Model"
          onChange={(e) => onConfig({ model: e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          className="picker"
          value={view.effort ?? ""}
          title="Reasoning effort"
          onChange={(e) => onConfig({ effort: e.target.value as EffortLevel })}
        >
          {EFFORTS.map((eff) => (
            <option key={eff.id} value={eff.id}>
              {eff.label}
            </option>
          ))}
        </select>
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
        <div className="pair-panel">
          <div className="pair-panel-label">Paste into your daemon as <code>WCC_PAIRED_PUBKEY</code>:</div>
          <code className="pair-panel-key">{identity.publicKeyB64}</code>
        </div>
      )}
    </header>
  );
}
