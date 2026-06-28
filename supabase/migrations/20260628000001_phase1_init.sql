-- ──────────────────────────────────────────────────────────────────────────────
-- WebClaudeCode / ClaudeBridge — Phase 1 initial schema (Story S1.1).
--
-- Five tables: devices, workspaces, sessions, pairing_codes, browser_keys.
-- Every table is RLS-locked to `auth.uid()`. The relay & web app read via the user's JWT (RLS
-- enforces ownership); the daemon writes its own device-scoped rows via the service role.
--
-- Naming + style follows Supabase Postgres best-practices: snake_case, uuid PKs, with_timestamps,
-- foreign keys ON DELETE CASCADE for owned children, btree indexes on FKs.
--
-- Idempotent: every statement uses `if not exists` / `create or replace` so the migration can be
-- re-run by the S1.6 gate (Supabase MCP `apply_migration`) without raising.
-- ──────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ───────────────────────── devices ─────────────────────────
-- One row per daemon registered to a user. `device_pubkey` is the long-term Ed25519 identity pubkey
-- the browser learned at enrollment time + the relay echoes back in directory lookups.
create table if not exists public.devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  device_pubkey text not null,
  token_hash    text not null,
  platform      text,
  created_at    timestamptz not null default now(),
  last_seen     timestamptz
);
create index if not exists devices_user_id_idx on public.devices (user_id);
create unique index if not exists devices_token_hash_unique on public.devices (token_hash);

alter table public.devices enable row level security;

drop policy if exists devices_select_own on public.devices;
create policy devices_select_own on public.devices
  for select using (auth.uid() = user_id);
drop policy if exists devices_insert_own on public.devices;
create policy devices_insert_own on public.devices
  for insert with check (auth.uid() = user_id);
drop policy if exists devices_update_own on public.devices;
create policy devices_update_own on public.devices
  for update using (auth.uid() = user_id);
drop policy if exists devices_delete_own on public.devices;
create policy devices_delete_own on public.devices
  for delete using (auth.uid() = user_id);

-- ───────────────────────── workspaces ─────────────────────────
create table if not exists public.workspaces (
  id              uuid primary key default gen_random_uuid(),
  device_id       uuid not null references public.devices (id) on delete cascade,
  name            text not null,
  root            text not null,
  git_repo        boolean not null default false,
  default_branch  text,
  created_at      timestamptz not null default now()
);
create index if not exists workspaces_device_id_idx on public.workspaces (device_id);

alter table public.workspaces enable row level security;

drop policy if exists workspaces_select_own on public.workspaces;
create policy workspaces_select_own on public.workspaces
  for select using (
    exists (select 1 from public.devices d where d.id = workspaces.device_id and d.user_id = auth.uid())
  );
drop policy if exists workspaces_modify_own on public.workspaces;
create policy workspaces_modify_own on public.workspaces
  for all using (
    exists (select 1 from public.devices d where d.id = workspaces.device_id and d.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.devices d where d.id = workspaces.device_id and d.user_id = auth.uid())
  );

-- ───────────────────────── sessions ─────────────────────────
-- METADATA only — session content stays on the daemon machine (audit split, per PLAN.md Phase 2).
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  title         text,
  state         text,                                   -- snapshot of last SessionState we saw
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);
create index if not exists sessions_workspace_id_idx on public.sessions (workspace_id);

alter table public.sessions enable row level security;

drop policy if exists sessions_select_own on public.sessions;
create policy sessions_select_own on public.sessions
  for select using (
    exists (
      select 1 from public.workspaces w
      join public.devices d on d.id = w.device_id
      where w.id = sessions.workspace_id and d.user_id = auth.uid()
    )
  );
drop policy if exists sessions_modify_own on public.sessions;
create policy sessions_modify_own on public.sessions
  for all using (
    exists (
      select 1 from public.workspaces w
      join public.devices d on d.id = w.device_id
      where w.id = sessions.workspace_id and d.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.workspaces w
      join public.devices d on d.id = w.device_id
      where w.id = sessions.workspace_id and d.user_id = auth.uid()
    )
  );

-- ───────────────────────── pairing_codes ─────────────────────────
-- Phase 1, decision D1: short-lived TTL-bounded pairing codes minted by the daemon. We store ONLY
-- the SHA-256 hash, never the code itself — so a compromised database snapshot can't be replayed.
create table if not exists public.pairing_codes (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references public.devices (id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  consumed    boolean not null default false,
  consumed_by_pubkey text,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists pairing_codes_device_id_idx on public.pairing_codes (device_id);
create index if not exists pairing_codes_expires_at_idx on public.pairing_codes (expires_at);

alter table public.pairing_codes enable row level security;
-- Browsers READ via the device-ownership check (so they can show "code expired" UI). Inserts
-- happen daemon-side via the service role.
drop policy if exists pairing_codes_select_own on public.pairing_codes;
create policy pairing_codes_select_own on public.pairing_codes
  for select using (
    exists (select 1 from public.devices d where d.id = pairing_codes.device_id and d.user_id = auth.uid())
  );

-- ───────────────────────── browser_keys ─────────────────────────
-- Phase 1, decision D3: enrolled browser signing keys (replaces Phase 0 env-injected pubkey).
create table if not exists public.browser_keys (
  id         uuid primary key default gen_random_uuid(),
  device_id  uuid not null references public.devices (id) on delete cascade,
  pubkey     text not null,
  label      text,
  enrolled_at timestamptz not null default now(),
  revoked    boolean not null default false,
  revoked_at timestamptz
);
create index if not exists browser_keys_device_id_idx on public.browser_keys (device_id);
create unique index if not exists browser_keys_device_pubkey_unique
  on public.browser_keys (device_id, pubkey) where not revoked;

alter table public.browser_keys enable row level security;

drop policy if exists browser_keys_select_own on public.browser_keys;
create policy browser_keys_select_own on public.browser_keys
  for select using (
    exists (select 1 from public.devices d where d.id = browser_keys.device_id and d.user_id = auth.uid())
  );
-- Browsers may REVOKE their own enrolled keys (defence against a stolen browser-key situation).
drop policy if exists browser_keys_update_own on public.browser_keys;
create policy browser_keys_update_own on public.browser_keys
  for update using (
    exists (select 1 from public.devices d where d.id = browser_keys.device_id and d.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.devices d where d.id = browser_keys.device_id and d.user_id = auth.uid())
  );
-- Inserts happen daemon-side (service role) on enroll_request success.

-- ──────────────────────────────────────────────────────────────────────────────
-- end Phase 1 init.
-- ──────────────────────────────────────────────────────────────────────────────
