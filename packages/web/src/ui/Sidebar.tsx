import { useState } from "react";
import type { MachineState, SessionMetaSummary } from "@wcc/shared";
import type { Identity } from "../identity.js";
import type { Theme } from "../theme.js";
import { SessionList } from "./SessionList.js";

/**
 * A slide-in drawer with three vertical sections: New session + past sessions on top, the
 * existing Settings block at the bottom. Opened by a ☰ button in the toolbar; a scrim behind
 * it closes on tap.
 */
export function Sidebar({
  open,
  onClose,
  identity,
  machine,
  theme,
  onToggleTheme,
  sessions,
  activeSessionId,
  displayedSessionId,
  onNewSession,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
}: {
  open: boolean;
  onClose: () => void;
  identity: Identity | null;
  machine: MachineState | undefined;
  theme: Theme;
  onToggleTheme: () => void;
  sessions: SessionMetaSummary[];
  activeSessionId: string | null;
  displayedSessionId: string | null;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    if (!identity) return;
    try {
      await navigator.clipboard.writeText(identity.publicKeyB64);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked (insecure origin); the <code> block is still selectable manually.
    }
  };

  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} aria-hidden />}
      <aside className={`sidebar ${open ? "open" : ""}`} aria-hidden={!open}>
        <div className="sidebar-head">
          <div className="sidebar-title">WebClaudeCode</div>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </div>

        <section className="sidebar-section">
          <SessionList
            sessions={sessions}
            activeId={activeSessionId}
            displayedId={displayedSessionId}
            onNewSession={onNewSession}
            onOpen={onOpenSession}
            onRename={onRenameSession}
            onDelete={onDeleteSession}
          />
        </section>

        <hr className="sidebar-sep" />

        <section className="sidebar-section">
          <div className="sidebar-label">Your machine</div>
          <div className="sidebar-machine">
            <span className={`dot ${machine?.online === false ? "off" : "on"}`} />
            <div className="sidebar-machine-body">
              <div className="sidebar-machine-name">{machine?.hostname ?? "(not connected)"}</div>
              {machine?.platform && (
                <div className="sidebar-machine-sub">{platformLabel(machine.platform)}</div>
              )}
            </div>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="sidebar-label">Appearance</div>
          <div className="sidebar-row">
            <span>Theme</span>
            <button className="btn small" onClick={onToggleTheme}>
              {theme === "dark" ? "🌙 Dark" : "☀ Light"}
            </button>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="sidebar-label">Pairing key</div>
          <p className="sidebar-help">
            Paste this into your daemon as <code>WCC_PAIRED_PUBKEY</code> to authorize this browser.
          </p>
          {identity ? (
            <>
              <code className="sidebar-key">{identity.publicKeyB64}</code>
              <button className="btn small" onClick={copyKey}>
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </>
          ) : (
            <div className="sidebar-help">Generating…</div>
          )}
        </section>
      </aside>
    </>
  );
}

function platformLabel(p: string): string {
  if (p === "win32") return "Windows";
  if (p === "darwin") return "macOS";
  if (p === "linux") return "Linux";
  return p;
}
