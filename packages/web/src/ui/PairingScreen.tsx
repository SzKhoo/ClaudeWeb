import { useState, type FormEvent } from "react";
import { formatCode } from "@wcc/shared";
import type { Identity } from "../identity.js";
import { type PairingResult } from "../pairing-flow.js";

export interface PairingScreenProps {
  identity: Identity;
  deviceId: string;
  /** Called when the user submits a code. Should perform `startPairing()`. */
  onSubmit: (code: string) => Promise<PairingResult>;
  /** Called when the user is done — usually to advance to the live session. */
  onDone: (result: PairingResult) => void;
}

export function PairingScreen({ identity, deviceId, onSubmit, onDone }: PairingScreenProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PairingResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onSubmit(code.trim());
      setDone(result);
    } catch (err) {
      const reason = (err as { reason?: string }).reason ?? "unknown";
      setError(`${reason}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="pairing pairing-done">
        <h2>Paired ✓</h2>
        <p>
          Browser key enrolled with device <code>{deviceId}</code> as keyId{" "}
          <code>{done.keyId}</code>.
        </p>
        <button onClick={() => onDone(done)}>Open session</button>
      </div>
    );
  }

  let displayCode: string | null = null;
  try {
    displayCode = code.trim() ? formatCode(code.trim()) : null;
  } catch {
    displayCode = null;
  }

  return (
    <div className="pairing">
      <h2>Pair this browser with your machine</h2>
      <p className="muted">
        On the trusted machine, run the daemon with <code>WCC_PRINT_PAIRING_CODE=1</code> (or invoke
        the pair CLI). A short code appears in its log — type it here. The code is one-shot and
        expires after 5 minutes.
      </p>
      <form onSubmit={submit} className="pairing-form">
        <label>
          Pairing code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XX"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {displayCode && (
          <div className="muted small">
            Will submit: <code>{displayCode}</code>
          </div>
        )}
        <button type="submit" disabled={busy || code.trim().length === 0}>
          {busy ? "Pairing…" : "Pair"}
        </button>
        {error && <div className="error">{error}</div>}
      </form>
      <details className="pairing-key">
        <summary>Browser public key (advanced)</summary>
        <code>{identity.publicKeyB64}</code>
      </details>
    </div>
  );
}
