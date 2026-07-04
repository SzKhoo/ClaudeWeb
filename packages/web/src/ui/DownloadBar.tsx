import { useState, type KeyboardEvent } from "react";

/**
 * A slim control to pull any workspace file down to the browser by path. Complements the per-tool-card
 * download button (which only appears for files a tool touched). Collapsed to a link until opened.
 */
export function DownloadBar({ onRequest, canSend }: { onRequest: (path: string) => void; canSend: boolean }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");

  const go = () => {
    const p = path.trim();
    if (!p || !canSend) return;
    onRequest(p);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  };

  if (!open) {
    return (
      <div className="download-bar">
        <button className="link" onClick={() => setOpen(true)} title="Download a file from the workspace">
          ⬇ get a file
        </button>
      </div>
    );
  }

  return (
    <div className="download-bar open">
      <input
        className="download-input"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="path/in/workspace.ext"
        autoFocus
      />
      <button className="btn" onClick={go} disabled={!canSend || path.trim().length === 0}>
        Download
      </button>
      <button className="link" onClick={() => setOpen(false)}>
        cancel
      </button>
    </div>
  );
}
