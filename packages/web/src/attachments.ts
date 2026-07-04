/**
 * Browser helpers for the attach/download features. Kept out of session-model.ts (which must stay
 * DOM-free for the node e2e) — these use FileReader / Blob / <a download>, so they only run in a page.
 */

import type { Attachment } from "@wcc/shared";

/** Read a picked File into an inline base64 Attachment (strips the `data:...;base64,` prefix). */
export async function fileToAttachment(file: File): Promise<Attachment> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
  return { name: file.name, mediaType: file.type || "application/octet-stream", data };
}

/**
 * A short random correlation id. Deliberately NOT crypto.randomUUID: on a phone over plain http the
 * page is a non-secure context where randomUUID can be missing. This id only correlates a reply, so
 * Math.random is fine.
 */
export function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Turn base64 bytes into a browser download (creates a transient object URL + clicks an <a>). */
export function downloadBase64(name: string, mediaType: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes as unknown as BlobPart], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
