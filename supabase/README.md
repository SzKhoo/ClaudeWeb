# Supabase wiring (Phase 1, S1.1 + S1.6 gate)

Schema + RLS for the multi-tenant shell. All Phase-1 application logic ships behind seams
(`AuthVerifier`, `Directory`, `AuthClient`) with in-memory impls and full unit tests; the real
Supabase project is the **manual integration gate** — analogous to Phase 0's 0A/0B.

## Tables (see `migrations/20260628000001_phase1_init.sql`)

| Table          | Purpose                                                                                       |
|----------------|-----------------------------------------------------------------------------------------------|
| `devices`      | One per daemon. Owns `device_pubkey` (long-term Ed25519 identity), hashed token, last seen.   |
| `workspaces`   | Allowlisted root dir per device. Drives the workspace-switch permission.                      |
| `sessions`     | **Metadata only.** Session content stays on the daemon (PLAN.md Phase 2 audit split).          |
| `pairing_codes`| Short-lived, hashed pairing codes (decision D1).                                              |
| `browser_keys` | Enrolled browser signing pubkeys; revocable (decision D3).                                    |

RLS: every table is `auth.uid()`-scoped. The daemon writes daemon-owned rows via the service role.

## Applying the migration (S1.6 gate)

The Supabase MCP server (`mcp__6389...__apply_migration` etc.) is the easiest path. From a fresh
project:

1. Create the project: `create_project { name: "wcc-phase-1-dev" }` (note the project_ref).
2. Apply: `apply_migration { project_id: <ref>, name: "phase1_init", query: <contents of migrations/20260628000001_phase1_init.sql> }`.
3. Generate types: `generate_typescript_types { project_id: <ref> }` → write to `packages/web/src/supabase-types.ts`.
4. Fetch keys: `get_publishable_keys`, `get_project_url`.
5. Wire env:
   - Relay: `RELAY_JWT_SECRET=<jwt secret>` + `RELAY_DAEMON_TOKENS=<json>` (or replace `InMemory*` with a Supabase-backed `Directory` / `DaemonTokenStore`).
   - Web: `VITE_SUPABASE_URL=<project url>` + `VITE_SUPABASE_ANON_KEY=<anon key>` and switch `Phase1Shell` to use `SupabaseAuthClient`.
6. Validate cross-user isolation live with two real accounts (Story S1.6 done-condition).

## What's deliberately NOT here yet

- Stripe / billing (Phase 2).
- Audit log table (Phase 2).
- Per-row encryption keys (full E2E payload encryption is Phase 2 stretch).

These are seam-reserved (see [docs/PLAN.md](../docs/PLAN.md)) and would land as additional migration
files when their phase starts.
