/**
 * AuthClient seam (Phase 1, S1.5). Abstracts identity-provider details so the rest of the UI doesn't
 * import Supabase. Two impls:
 *
 *   - MockAuthClient: tests + local dev. Mints HS256 JWTs locally so the relay's JwtAuthVerifier path
 *     can be exercised end-to-end without a real Supabase project.
 *   - SupabaseAuthClient: production. Wired at the S1.6 manual gate.
 *
 * State model: synchronous `current()` (so React can render immediately) + async `subscribe()` for
 * sign-in/sign-out transitions. Minimal — no profile editing, no email change — Phase 1 ships only
 * what the slice needs.
 */

import { signJwtHs256 } from "@wcc/shared";

export interface AuthSession {
  userId: string;
  email?: string;
  /** Bearer token the relay will verify. For Supabase = the access_token (JWT). */
  accessToken: string;
}

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: AuthSession };

export type AuthListener = (state: AuthState) => void;

export interface AuthClient {
  current(): AuthState;
  subscribe(listener: AuthListener): () => void;
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  signOut(): Promise<void>;
}

// ───────────────────────────── MockAuthClient ─────────────────────────────

export interface MockAuthClientOptions {
  /** HS256 secret used to mint local JWTs. Must match the relay's RELAY_JWT_SECRET in dev. */
  jwtSecret: Uint8Array;
  /** Map email → {userId, password}. */
  users: Record<string, { userId: string; password: string }>;
  /** Token lifetime in seconds. Default 1h. */
  tokenLifetimeS?: number;
  /** Persist the signed-in session in localStorage (default true). */
  persist?: boolean;
  now?: () => number;
}

const STORAGE_KEY = "wcc.auth.v1";

export class MockAuthClient implements AuthClient {
  private state: AuthState = { status: "loading" };
  private readonly listeners = new Set<AuthListener>();
  private readonly now: () => number;

  constructor(private readonly opts: MockAuthClientOptions) {
    this.now = opts.now ?? Date.now;
    this.state = this.loadPersisted() ?? { status: "signed-out" };
  }

  current(): AuthState {
    return this.state;
  }

  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async signInWithPassword(email: string, password: string): Promise<AuthSession> {
    const user = this.opts.users[email];
    if (!user || user.password !== password) {
      throw new Error("invalid email or password");
    }
    const nowS = Math.floor(this.now() / 1000);
    const exp = nowS + (this.opts.tokenLifetimeS ?? 3600);
    const accessToken = await signJwtHs256(
      { sub: user.userId, iat: nowS, exp, email },
      this.opts.jwtSecret,
    );
    const session: AuthSession = { userId: user.userId, email, accessToken };
    this.setState({ status: "signed-in", session });
    this.persist(session);
    return session;
  }

  async signOut(): Promise<void> {
    this.setState({ status: "signed-out" });
    if (this.opts.persist !== false && typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  private setState(s: AuthState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  private loadPersisted(): AuthState | undefined {
    if (this.opts.persist === false) return undefined;
    if (typeof localStorage === "undefined") return undefined;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return undefined;
      const session = JSON.parse(raw) as AuthSession;
      if (session && typeof session.userId === "string" && typeof session.accessToken === "string") {
        return { status: "signed-in", session };
      }
    } catch {
      /* corrupt */
    }
    return undefined;
  }

  private persist(session: AuthSession): void {
    if (this.opts.persist === false) return;
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* ignore quota */
    }
  }
}

// ───────────────────────────── SupabaseAuthClient (S1.6 gate stub) ─────────────────────────────

export interface SupabaseAuthClientOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/**
 * Stub for the Supabase implementation. Throws on use until the S1.6 manual gate wires it up to the
 * @supabase/supabase-js client. Kept here so the dev path stays compile-clean and so the UI can be
 * written against the SAME `AuthClient` interface today.
 */
export class SupabaseAuthClient implements AuthClient {
  constructor(_opts: SupabaseAuthClientOptions) {
    /* held until S1.6 */
  }
  current(): AuthState {
    return { status: "signed-out" };
  }
  subscribe(_l: AuthListener): () => void {
    return () => {};
  }
  signInWithPassword(_email: string, _password: string): Promise<AuthSession> {
    throw new Error("SupabaseAuthClient: pending S1.6 manual gate");
  }
  signOut(): Promise<void> {
    throw new Error("SupabaseAuthClient: pending S1.6 manual gate");
  }
}
