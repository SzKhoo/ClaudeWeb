import { useEffect, useRef } from "react";
import type { TranscriptItem } from "../session-model.js";

/** The streaming conversation: user/assistant bubbles, tool cards, system + error lines. */
export function Transcript({ items }: { items: TranscriptItem[] }) {
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
        <Item key={item.id} item={item} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="bubble user">
          <span className="role">you</span>
          <div className="text">{item.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="bubble assistant">
          <span className="role">claude</span>
          <div className="text">
            {item.text}
            {item.streaming && <span className="cursor">▍</span>}
          </div>
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
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

function ToolCard({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const path = typeof item.input === "object" && item.input && "path" in item.input ? String((item.input as { path: unknown }).path) : undefined;
  return (
    <div className="tool-card">
      <div className="tool-head">
        <span className="tool-name">{item.name}</span>
        {path && <span className="tool-path">{path}</span>}
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
