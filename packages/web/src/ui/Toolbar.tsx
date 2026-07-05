import { useEffect, useRef, useState } from "react";
import type { EffortLevel, ExecutionMode } from "@wcc/shared";
import type { SessionView } from "../session-model.js";
import type { ConnectionStatus } from "../protocol-client.js";

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

interface Option<T extends string> {
  id: T;
  label: string;
  icon?: string;
  hint?: string;
}

/**
 * Concrete choices only — no "Default" placeholder. When the daemon has not yet reported an active
 * model/effort we display the FALLBACK entries below (Opus 4.7 / Medium) rather than a vague label.
 */
const MODELS: Option<string>[] = [
  { id: "claude-opus-4-7", label: "Opus 4.7", hint: "Recommended" },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Highest quality" },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Balanced" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest" },
];
const FALLBACK_MODEL = MODELS[0]!.id;

const EFFORTS: Option<string>[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];
const FALLBACK_EFFORT = "medium";

const MODES: Option<ExecutionMode>[] = [
  { id: "manual", label: "Manual", icon: "🔒", hint: "Every tool needs approval" },
  { id: "auto-edits", label: "Auto edits", icon: "✏️", hint: "Edits auto-approved; Bash/network still ask" },
  { id: "yolo", label: "YOLO", icon: "🚀", hint: "Everything auto-approved" },
];

/**
 * Compact header row: status pill + tiny icon selectors for model / effort / mode + a ☰ that opens
 * the settings sidebar. Each selector renders its current value as a chip; tapping expands a popover
 * with the choices. Fits a phone in portrait without wrapping the pairing key off-screen.
 */
export function Toolbar({
  status,
  view,
  onMode,
  onConfig,
  onOpenSidebar,
}: {
  status: ConnectionStatus;
  view: SessionView;
  onMode: (mode: ExecutionMode) => void;
  onConfig: (config: { model?: string; effort?: EffortLevel }) => void;
  onOpenSidebar: () => void;
}) {
  const online = status === "ready";

  return (
    <header className="toolbar">
      <div className="tb-brand">
        <span className="tb-brand-name">ClaudeBridge</span>
      </div>
      <div className="tb-status">
        <span className={`dot ${online ? "on" : status === "daemon-offline" ? "warn" : "off"}`} />
        <span className="tb-status-text">{STATUS_LABEL[status]}</span>
        <span className="sep">·</span>
        <span className="tb-state">{STATE_LABEL[view.state] ?? view.state}</span>
      </div>
      <div className="tb-controls">
        <PopoverPicker
          title="Model"
          icon="🧠"
          value={view.model ?? FALLBACK_MODEL}
          options={MODELS}
          onPick={(id) => onConfig({ model: id })}
        />
        <PopoverPicker
          title="Effort"
          icon="⚡"
          value={view.effort ?? FALLBACK_EFFORT}
          options={EFFORTS}
          onPick={(id) => onConfig({ effort: id as EffortLevel })}
        />
        <PopoverPicker
          title="Mode"
          icon={modeIcon(view.executionMode)}
          value={view.executionMode ?? "manual"}
          options={MODES}
          onPick={(id) => onMode(id as ExecutionMode)}
        />
        <button className="icon-btn" onClick={onOpenSidebar} title="Settings" aria-label="Settings">
          ☰
        </button>
      </div>
    </header>
  );
}

function modeIcon(m: ExecutionMode | undefined): string {
  return MODES.find((x) => x.id === (m ?? "manual"))?.icon ?? "🔒";
}

/** A compact button that opens a small popover with radio-style options. Closes on outside click. */
function PopoverPicker<T extends string>({
  title,
  icon,
  value,
  options,
  onPick,
}: {
  title: string;
  icon: string;
  value: T | "";
  options: Option<T | "">[];
  onPick: (id: T | "") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="picker-wrap" ref={ref}>
      <button
        className="picker-btn"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="picker-icon">{icon}</span>
        <span className="picker-value">{current?.label ?? title}</span>
      </button>
      {open && (
        <div className="picker-pop" role="listbox">
          <div className="picker-pop-title">{title}</div>
          {options.map((o) => (
            <button
              key={o.id}
              className={`picker-opt ${o.id === value ? "on" : ""}`}
              role="option"
              aria-selected={o.id === value}
              onClick={() => {
                onPick(o.id);
                setOpen(false);
              }}
            >
              {o.icon && <span className="picker-opt-icon">{o.icon}</span>}
              <span className="picker-opt-label">{o.label}</span>
              {o.hint && <span className="picker-opt-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
