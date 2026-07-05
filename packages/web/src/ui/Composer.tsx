import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { Attachment } from "@wcc/shared";
import { fileToAttachment } from "../attachments.js";

/**
 * Prompt input. Enter sends, Shift+Enter newlines. Shows Interrupt while a turn runs.
 * The `+` button expands to three attach paths so touch-first users see the choices instead of
 * a single opaque picker: Camera (live capture on mobile), Images (gallery), Files (anything).
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
  const [menuOpen, setMenuOpen] = useState(false);

  const cameraInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const pickVia = (r: React.RefObject<HTMLInputElement | null>) => () => {
    setMenuOpen(false);
    r.current?.click();
  };

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
        {/* Three hidden inputs so we can lock each button to a distinct picker semantics. */}
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPick(e)} />
        <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(e) => void onPick(e)} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void onPick(e)} />

        <div className="attach-menu-wrap" ref={menuRef}>
          <button
            className="btn attach"
            title="Add attachments"
            disabled={!canSend}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? "×" : "+"}
          </button>
          {menuOpen && (
            <div className="attach-menu" role="menu">
              <button className="attach-menu-item" role="menuitem" onClick={pickVia(cameraInput)}>
                <span className="ami-icon">📷</span>
                <span className="ami-label">Camera</span>
                <span className="ami-hint">Take a photo</span>
              </button>
              <button className="attach-menu-item" role="menuitem" onClick={pickVia(imageInput)}>
                <span className="ami-icon">🖼</span>
                <span className="ami-label">Images</span>
                <span className="ami-hint">Pick from gallery</span>
              </button>
              <button className="attach-menu-item" role="menuitem" onClick={pickVia(fileInput)}>
                <span className="ami-icon">📎</span>
                <span className="ami-label">Files</span>
                <span className="ami-hint">Any file type</span>
              </button>
            </div>
          )}
        </div>

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
