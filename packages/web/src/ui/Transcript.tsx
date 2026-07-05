import { useEffect, useRef } from "react";
import type { TranscriptItem } from "../session-model.js";
import { Markdown } from "./Markdown.js";

/** The streaming conversation: user/assistant bubbles, tool cards, system + error lines. */
export function Transcript({
  items,
  onDownload,
}: {
  items: TranscriptItem[];
  /** Ask the daemon to send back a workspace file (path relative to the workspace root). */
  onDownload?: (path: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items]);

  return (
    <div className="transcript">
      {items.length === 0 && (
        <div className="empty">
          Ask Claude to do something on your machine — e.g. <code>create hello.txt with content "hi"</code>.
        </div>
      )}
      {items.map((item) => (
        <Item key={item.id} item={item} onDownload={onDownload} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Item({ item, onDownload }: { item: TranscriptItem; onDownload?: (path: string) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="bubble user">
          <span className="role">you</span>
          <div className="text">{item.text}</div>
          {item.attachments && item.attachments.length > 0 && (
            <div className="attach-chips sent">
              {item.attachments.map((a, i) => (
                <span className="attach-chip" key={`${a.name}-${i}`} title={a.mediaType}>
                  {a.mediaType.startsWith("image/") ? "🖼" : "📄"} {a.name}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "assistant":
      return (
        <div className="bubble assistant">
          <span className="role">claude</span>
          <div className="text md-text">
            <Markdown text={item.text} />
            {item.streaming && <span className="cursor">▍</span>}
          </div>
        </div>
      );
    case "tool":
      return <ToolCard item={item} onDownload={onDownload} />;
    case "system":
      return <div className={`line system ${item.level}`}>{item.text}</div>;
    case "error":
      return (
        <div className="line error">
          <strong>{item.code}</strong> — {item.message}
        </div>
      );
  }
}

/** Pull a workspace-relative file path out of a tool's input (Write/Edit/Read use file_path or path). */
function toolPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const p = rec["file_path"] ?? rec["path"] ?? rec["notebook_path"];
  return typeof p === "string" ? p : undefined;
}

function ToolCard({
  item,
  onDownload,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
  onDownload?: (path: string) => void;
}) {
  const path = toolPath(item.input);
  return (
    <div className="tool-card">
      <div className="tool-head">
        <span className="tool-name">{item.name}</span>
        {path && <span className="tool-path">{path}</span>}
        {path && onDownload && (
          <button
            className="link tool-download"
            title={`Download ${path}`}
            onClick={() => onDownload(path)}
          >
            ⬇
          </button>
        )}
        {item.result && (
          <span className={`tool-badge ${item.result.ok ? "ok" : "fail"}`}>
            {item.result.ok ? "done" : "failed"}
          </span>
        )}
      </div>
      {item.output && <pre className="tool-output">{item.output}</pre>}
      {item.result?.summary && <div className="tool-summary">{item.result.summary}</div>}
    </div>
  );
}
