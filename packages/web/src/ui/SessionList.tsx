import { useState } from "react";
import type { SessionMetaSummary } from "@wcc/shared";

export interface SessionListProps {
  sessions: SessionMetaSummary[];
  activeId: string | null;
  displayedId: string | null;
  onNewSession: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function SessionList({
  sessions,
  activeId,
  displayedId,
  onNewSession,
  onOpen,
  onRename,
  onDelete,
}: SessionListProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);

  return (
    <div className="session-list">
      <button className="btn primary block" onClick={onNewSession}>
        + New session
      </button>
      <div className="sidebar-label">Sessions</div>
      {sessions.length === 0 ? (
        <div className="sidebar-help">No sessions yet.</div>
      ) : (
        <ul className="session-rows">
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            const isDisplayed = s.id === displayedId;
            const isSummarizing = s.status === "closed" && s.title === null;
            const label = s.title ?? "(untitled)";
            return (
              <li
                key={s.id}
                className={`session-row ${isDisplayed ? "displayed" : ""}`}
                onClick={() => {
                  setMenuFor(null);
                  onOpen(s.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuFor(s.id);
                }}
              >
                <span className={`session-dot ${isActive ? "active" : ""}`} />
                <div className="session-row-body">
                  <div className="session-row-title">{isSummarizing ? "Summarizing…" : label}</div>
                  <div className="session-row-sub">{relative(s.lastActivityAt)}</div>
                </div>
                {menuFor === s.id && (
                  <div className="session-menu" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => {
                        const t = window.prompt("Rename session", s.title ?? "");
                        if (t !== null && t.trim().length > 0) onRename(s.id, t.trim());
                        setMenuFor(null);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      disabled={isActive}
                      onClick={() => {
                        if (window.confirm("Delete this session? This cannot be undone.")) onDelete(s.id);
                        setMenuFor(null);
                      }}
                    >
                      Delete
                    </button>
                    <button onClick={() => setMenuFor(null)}>Cancel</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function relative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
