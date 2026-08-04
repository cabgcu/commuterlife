-- ============================================================================
-- Optimistic concurrency for app_state
--
-- The problem this fixes: every save (_doSaveData() in index.html) writes
-- the ENTIRE in-memory appData blob to app_state.id=1. A device that goes
-- idle — a laptop left open overnight, a phone tab backgrounded by the OS,
-- a socket that dropped without visibly erroring — keeps a stale in-memory
-- copy. If that device saves *after* other people have since made changes,
-- its stale copy was, until this migration, written straight over their
-- work with no check at all: classic last-write-wins data loss.
--
-- Fix: give app_state a version counter that only the SERVER increments,
-- on every UPDATE, regardless of what the client sends. The client
-- remembers the version it last read and conditions every save on it
-- (`.eq('id', 1).eq('version', knownVersion)`). If someone else saved in
-- the meantime, the WHERE clause matches zero rows — the write is a no-op
-- instead of an overwrite — and index.html's _doSaveData() detects that
-- and pulls the fresh data in instead of silently discarding it (see
-- _handleSaveConflict() in index.html).
--
-- This is the standard optimistic-locking pattern for exactly this
-- situation: many clients (some idle, some active) sharing one mutable
-- row, no per-field diffing available. It turns silent overwrites into a
-- detectable, recoverable conflict.
--
-- Purely additive — safe to re-run:
--   * ADD COLUMN ... DEFAULT backfills the existing row(s) with version=1
--     without touching `data`.
--   * The trigger is CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
-- ============================================================================

alter table public.app_state add column if not exists version bigint not null default 1;
alter table public.app_state add column if not exists updated_at timestamptz not null default now();

create or replace function public.app_state_bump_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    -- The server is the only writer of version/updated_at — ignore whatever
    -- the client sent for them, so a stale client can't fake a version bump
    -- to force a conflicting write through.
    new.version = old.version + 1;
    new.updated_at = now();
    return new;
end;
$$;

-- Runs before trg_app_state_reject_empty / trg_app_state_snapshot
-- (alphabetical trigger ordering) but doesn't interact with either: it only
-- touches NEW.version/NEW.updated_at, which neither of those triggers reads.
drop trigger if exists trg_app_state_bump_version on public.app_state;
create trigger trg_app_state_bump_version
    before update on public.app_state
    for each row
    execute function public.app_state_bump_version();

-- ============================================================================
-- How the client uses this (already wired up in index.html):
--
--   -- on load / refresh:
--   select data, version from app_state where id = 1;
--   -- remember `version` as _appStateVersion
--
--   -- on save:
--   update app_state set data = :newData
--   where id = 1 and version = :_appStateVersion
--   returning version;
--   -- zero rows returned => someone else saved first; re-fetch instead of
--   -- retrying the write with the stale blob.
-- ============================================================================
