import { useState, type FormEvent } from "react";
import type { AuthClient } from "../auth-client.js";

export function LoginScreen({ auth, onSignedIn }: { auth: AuthClient; onSignedIn: () => void }) {
  const [email, setEmail] = useState("alice@example.com");
  const [password, setPassword] = useState("alice-pw");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.signInWithPassword(email, password);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <h1>ClaudeBridge</h1>
      <p className="muted">Sign in to drive Claude Code on your own machine.</p>
      <form onSubmit={submit} className="login-form">
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && <div className="error">{error}</div>}
      </form>
      <p className="muted small">
        Phase 1 dev defaults: <code>alice@example.com</code> / <code>alice-pw</code>.
      </p>
    </div>
  );
}
