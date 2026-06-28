import { useState, type KeyboardEvent } from "react";

/** The prompt input. Enter sends; Shift+Enter inserts a newline. Shows Interrupt while a turn runs. */
export function Composer({
  onSend,
  canSend,
  busy,
  onInterrupt,
}: {
  onSend: (text: string) => void;
  canSend: boolean;
  busy: boolean;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || !canSend) return;
    onSend(trimmed);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
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
        <button className="btn send" onClick={submit} disabled={!canSend || text.trim().length === 0}>
          Send
        </button>
      )}
    </div>
  );
}
