import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { Attachment } from "@wcc/shared";
import { fileToAttachment } from "../attachments.js";

/**
 * The prompt input. Enter sends; Shift+Enter inserts a newline. Shows Interrupt while a turn runs.
 * A 📎 button attaches images/files (read inline as base64) that ride along with the next message.
 */
export function Composer({
  onSend,
  canSend,
  busy,
  onInterrupt,
}: {
  onSend: (text: string, attachments?: Attachment[]) => void;
  canSend: boolean;
  busy: boolean;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const hasContent = text.trim().length > 0 || attachments.length > 0;

  const submit = () => {
    if (!hasContent || !canSend) return;
    onSend(text.trim(), attachments.length > 0 ? attachments : undefined);
    setText("");
    setAttachments([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    const added = await Promise.all(files.map(fileToAttachment));
    setAttachments((prev) => [...prev, ...added]);
  };

  const remove = (i: number) => setAttachments((prev) => prev.filter((_, idx) => idx !== i));

  return (
    <div className="composer-wrap">
      {attachments.length > 0 && (
        <div className="attach-chips">
          {attachments.map((a, i) => (
            <span className="attach-chip" key={`${a.name}-${i}`} title={a.mediaType}>
              {a.mediaType.startsWith("image/") ? "🖼" : "📄"} {a.name}
              <button className="attach-x" onClick={() => remove(i)} aria-label={`Remove ${a.name}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => void onPick(e)}
        />
        <button
          className="btn attach"
          title="Attach images or files"
          disabled={!canSend}
          onClick={() => fileInput.current?.click()}
        >
          📎
        </button>
        <textarea
          className="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={canSend ? "Message Claude…  (Enter to send)" : "Connecting to your machine…"}
        />
        {busy ? (
          <button className="btn interrupt" onClick={onInterrupt}>
            Interrupt
          </button>
        ) : (
          <button className="btn send" onClick={submit} disabled={!canSend || !hasContent}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
